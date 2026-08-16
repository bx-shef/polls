import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Плагин чистки — ИСПОЛНЯЕМЫЙ гард: модуль реально загружается, его таймеры реально тикают.
 *
 * ⚠️ Заведён по итогам ревью, и повод предметный: вся проводка приглашений (`useInvitations`,
 * `LazyInvitationStore`, `usePgInvitations`, этот плагин) не упоминалась НИ В ОДНОМ тесте, и восемь
 * мутаций подряд проходили полный набор из 1130 тестов. Самые страшные из них — бесшумные: снимите
 * гейт по БД, и чистка ПДн просто перестанет идти; выключите выбор реализации, и приглашения
 * вернутся в память, то есть весь переезд окажется несделанным. Ни лог, ни ответ, ни тест этого не
 * показали бы.
 *
 * `defineNitroPlugin`, таймеры и `clear*` подменяются глобально (в модуле это свободные
 * идентификаторы) — прод-код ради теста не тронут ни одной строкой.
 */
const sweepExpired = vi.fn(async () => 0)
const usePgInvitations = vi.fn(async (): Promise<{ sweepExpired: typeof sweepExpired } | undefined> => undefined)
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../server/utils/api', () => ({ logger, usePgInvitations }))

interface Handle { unref?: () => void }
async function load() {
  vi.resetModules()
  const unrefed: string[] = []
  const timers: { fn: () => void; kind: string; cleared: boolean }[] = []
  const mk = (kind: string) => (fn: () => void): Handle => {
    timers.push({ fn, kind, cleared: false })
    return { unref: () => unrefed.push(kind) }
  }
  vi.stubGlobal('setTimeout', mk('timeout'))
  vi.stubGlobal('setInterval', mk('interval'))
  vi.stubGlobal('clearTimeout', () => timers.filter((t) => t.kind === 'timeout').forEach((t) => { t.cleared = true }))
  vi.stubGlobal('clearInterval', () => timers.filter((t) => t.kind === 'interval').forEach((t) => { t.cleared = true }))
  const hooks: Record<string, () => void> = {}
  vi.stubGlobal('defineNitroPlugin', (fn: unknown) => fn)
  const mod = await import('../server/plugins/invitation-retention')
  ;(mod.default as unknown as (a: unknown) => void)({ hooks: { hook: (n: string, f: () => void) => { hooks[n] = f } } })
  const tick = async (kind: string): Promise<void> => {
    for (const t of timers.filter((x) => x.kind === kind && !x.cleared)) t.fn()
    await new Promise((r) => setImmediate(r))
  }
  return { unrefed, timers, hooks, tick }
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('плагин чистки приглашений', () => {
  it('оба таймера unref-нуты — иначе процесс не завершится', async () => {
    expect((await load()).unrefed.sort()).toEqual(['interval', 'timeout'])
  })
  it('без БД (usePgInvitations → undefined) тик молчит и НЕ падает', async () => {
    const { tick } = await load()
    await tick('timeout')
    expect(logger.warn).not.toHaveBeenCalled() // упади тик — здесь был бы invitation_sweep_fail
    // Стартовый след при этом есть всегда (владелец должен видеть, что удержание включено), а вот
    // счётчика подметённого быть не должно: подметать нечего.
    expect(logger.info).toHaveBeenCalledWith('invitation_retention_on', expect.anything())
    expect(logger.info).not.toHaveBeenCalledWith('invitations_swept', expect.anything())
  })
  it('с БД тик подметает и пишет счётчик; keepDays берётся из env', async () => {
    process.env.INVITATION_KEEP_DAYS = '7'
    usePgInvitations.mockResolvedValue({ sweepExpired })
    sweepExpired.mockResolvedValue(3)
    const { tick } = await load()
    await tick('timeout')
    expect(sweepExpired).toHaveBeenCalledWith(expect.any(Date), 7)
    expect(logger.info).toHaveBeenCalledWith('invitations_swept', { count: 3, olderThanDays: 7 })
    delete process.env.INVITATION_KEEP_DAYS
  })
  it('падение чистки не роняет процесс — пишется warn', async () => {
    usePgInvitations.mockRejectedValue(new Error('БД недоступна'))
    const { tick } = await load()
    await tick('timeout')
    expect(logger.warn).toHaveBeenCalledWith('invitation_sweep_fail', { reason: 'БД недоступна' })
  })
  it('close гасит ОБА таймера — периодический тоже', async () => {
    const { hooks, timers } = await load()
    hooks.close!()
    expect(timers.filter((t) => !t.cleared), 'таймер пережил close').toHaveLength(0)
  })
})
