import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'

/**
 * Проводка закрытия дела к `submit` (#177) — ИСПОЛНЯЕМЫЙ гард.
 *
 * ⚠️ Мутационный прогон показал, ради чего он нужен: убрать `onAnswered` из `createApi` — и весь
 * набор остаётся зелёным, а дела в таймлайне не закрывает больше никто. Ядро покрыто, но ядро зовёт
 * хук само; в проде его подключает ровно одна строка, и она не исполнялась ничем.
 *
 * Мокаются два модуля: драйвер `pg` (пул ходит в pglite вместо сокета) и клиент портала (вместо REST
 * — журнал вызовов). Всё между ними настоящее: `server/utils/api.ts`, `close-invite.ts`, ядровой
 * `submit`, `PgStore`, `PgInvitationStore`, `PortalTokenStore`.
 */
const pglite = new PGlite()
class FakePool {
  constructor(_o: unknown) {}
  on(): void {}
  async query(sql: string, params?: unknown[]) {
    if (params === undefined) { const r = await pglite.exec(sql); return r[r.length - 1] ?? { rows: [] } }
    return pglite.query(sql, params)
  }
  connect() {
    return Promise.resolve({ query: (s: string, p?: unknown[]) => pglite.query(s, p), release: () => {} })
  }
}
vi.mock('pg', () => ({ default: { Pool: FakePool }, Pool: FakePool }))

/** Журнал REST-вызовов вместо похода в портал. */
const restCalls: Array<{ method: string; params?: Record<string, unknown> }> = []
vi.mock('~core/bitrix24/client', async (orig) => {
  const real = await orig<typeof import('../src/bitrix24/client')>()
  return {
    ...real,
    createPortalClient: () => ({
      actions: { v2: { call: { make: async (opts: { method: string; params?: Record<string, unknown> }) => {
        restCalls.push({ method: opts.method, params: opts.params })
        const result = opts.method === 'crm.activity.list'
          ? [{ ID: 77, ORIGIN_ID: 'stage:4242:csat_postdeal' }]
          : true
        return { isSuccess: true, getData: () => ({ result, time: {} }), getErrorMessages: () => [] }
      } } } }
    })
  }
})

const KEY_HEX = 'b'.repeat(64)
const MEMBER = 'member-close-00000000000000'

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgres://fake/fake'
  process.env.NUXT_BITRIX_TOKEN_KEY = KEY_HEX
  process.env.NUXT_B24_CLIENT_ID = 'cid'
  process.env.NUXT_B24_CLIENT_SECRET = 'csecret'
  process.env.DOMAIN = 'polls.example'
  const { applySchema } = await import('./helpers/schema')
  await applySchema(pglite)
})
afterAll(async () => {
  for (const k of ['DATABASE_URL', 'NUXT_BITRIX_TOKEN_KEY', 'NUXT_B24_CLIENT_ID', 'NUXT_B24_CLIENT_SECRET', 'DOMAIN']) {
    delete process.env[k]
  }
  await pglite.close()
})

describe('submit → закрытие дела в таймлайне', () => {
  it('успешный ответ по приглашению со сделкой доходит до CRM', async () => {
    const { useApi, useStore, useInvitations } = await import('../server/utils/api')
    const { usePortalTokenStore } = await import('../server/utils/portal')
    const { SURVEY_KEY, draftV2 } = await import('../src/demo/seed')

    const store = await useStore()
    if (!(await store.currentVersion(SURVEY_KEY))) await store.publish(draftV2(), 2)

    // Портал установлен: без него закрытие штатно выходит раньше REST.
    const tokenStore = await usePortalTokenStore()
    expect(tokenStore, 'стор токенов не поднялся — тест ничего не проверит').toBeTruthy()
    await tokenStore!.save({
      memberId: MEMBER,
      domain: 'acme.bitrix24.ru',
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString()
    }, { adoptLocal: true })

    const inv = await useInvitations().create(
      { surveyKey: SURVEY_KEY, versionNo: 2, context: { dealId: 759 } },
      new Date()
    )
    const api = await useApi()
    const nonce = (await api.session({ ip: 'a' })).body as { nonce: string }
    const r = await api.submit({
      ip: 'a',
      body: {
        schema_version: 1,
        nonce: nonce.nonce,
        hp: '',
        surveyKey: SURVEY_KEY,
        versionNo: 2,
        invitation: inv.token,
        answers: { q_nps: { values: ['n9'] }, q_csat: { values: ['s4'] }, q_liked: { values: ['speed'] } }
      }
    })
    expect(r.status, JSON.stringify(r.body)).toBe(200)

    const methods = restCalls.map((c) => c.method)
    expect(methods, 'закрытие дела не подключено к submit').toContain('crm.activity.list')
    expect(methods, 'найденное дело не закрыто').toContain('crm.activity.update')
    const update = restCalls.find((c) => c.method === 'crm.activity.update')
    expect(update?.params).toEqual({ id: 77, fields: { COMPLETED: 'Y' } })
  }, 60_000)
})
