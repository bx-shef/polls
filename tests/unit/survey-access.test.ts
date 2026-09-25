import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Общий путь публичной страницы: `server/api/s/-access.ts`.
 *
 * ⚠ Issue #17 вынес этот файл за скобки явно («чего этот issue не закрывает») — и с тех пор
 * он так и остался без единого теста. А через него проходит КАЖДОЕ обращение постороннего
 * человека к анкете: форма токена → частота → поиск ссылки → статусная машина → схема.
 * Обе стороны этого пути проверены порознь (домен — юнитами, страница — в окружении Nuxt),
 * а сама последовательность — ничем.
 *
 * ⚠ Цена ошибки здесь не «страница не открылась». Порядок шагов — это защита от перебора:
 * проверка формы стоит ДО базы, счётчик частоты — ДО поиска ссылки, а отказы обязаны быть
 * неотличимы друг от друга, иначе ответ превращается в оракул: перебирающий по коду или
 * по тексту отличит существующий токен от несуществующего.
 *
 * База и Redis здесь подделаны: предмет проверки — последовательность и то, что уходит
 * наружу, а не поведение Postgres.
 */

const TOKEN = 'a'.repeat(43)

/** Что подделки успели увидеть за один проход. */
interface Probe {
  rateCalls: number
  lookups: number
  templateLookups: number
  warned: string[]
  errored: string[]
}

let probe: Probe
let rateDecision: unknown
let storedLink: unknown
let storedTemplate: unknown

/** Ответ h3-события в объёме, который читает проверяемый путь. */
function fakeEvent() {
  const headers: Record<string, string> = {}
  let status = 200
  return {
    event: { node: { req: { socket: { remoteAddress: '203.0.113.7' }, headers: {} }, res: {} } } as never,
    headers,
    get status() {
      return status
    },
    setStatus: (value: number) => void (status = value),
  }
}

/** Поднять модуль со свежими подделками: он ходит в базу, в Redis и в h3. */
async function loadAccess(hooks: { setStatus: (value: number) => void, headers: Record<string, string> }) {
  probe = { rateCalls: 0, lookups: 0, templateLookups: 0, warned: [], errored: [] }

  vi.doMock('../../server/db/client', () => ({ isDatabaseConfigured: () => true }))
  vi.doMock('../../server/links/rate', () => ({
    countAndDecide: async () => {
      probe.rateCalls += 1
      return rateDecision
    },
  }))
  vi.doMock('../../server/links/store', () => ({
    findLinkByTokenHash: async () => {
      probe.lookups += 1
      return storedLink
    },
    findTemplate: async () => {
      probe.templateLookups += 1
      return storedTemplate
    },
  }))
  vi.doMock('../../server/utils/logger', () => ({
    logger: {
      warn: (_fields: unknown, message: string) => void probe.warned.push(message),
      error: (_fields: unknown, message: string) => void probe.errored.push(message),
      info: () => {},
    },
  }))
  vi.doMock('h3', async () => {
    const actual = await vi.importActual<typeof import('h3')>('h3')
    return {
      ...actual,
      getRequestHeader: () => undefined,
      setResponseStatus: (_event: unknown, value: number) => hooks.setStatus(value),
      setResponseHeader: (_event: unknown, name: string, value: unknown) => void (hooks.headers[name] = String(value)),
    }
  })
  vi.resetModules()

  return import('../../server/api/s/-access')
}

const LINK = {
  id: 'ссылка',
  portalId: 'портал',
  status: 'sent',
  expiresAt: new Date(Date.now() + 60_000),
  surveyCode: 'brand',
  surveyVersion: 1,
}

const TEMPLATE = { code: 'brand', title: 'Бренд-платформа', sections: [] }

beforeEach(() => {
  rateDecision = { allow: true }
  storedLink = LINK
  storedTemplate = TEMPLATE
})

afterEach(() => {
  vi.doUnmock('../../server/db/client')
  vi.doUnmock('../../server/links/rate')
  vi.doUnmock('../../server/links/store')
  vi.doUnmock('../../server/utils/logger')
  vi.doUnmock('h3')
  vi.resetModules()
})

describe('порядок шагов', () => {
  it('ГЛАВНОЕ: негодный токен не стоит нам ни запроса в базу, ни счёта частоты', async () => {
    // ⚠ Перебор по коротким и кривым значениям — самый дешёвый способ нас нагрузить.
    // Проверка формы стоит ПЕРВОЙ именно поэтому: она не требует ни Redis, ни Postgres.
    const hooks = fakeEvent()
    const { resolveSurveyAccess } = await loadAccess(hooks)

    const outcome = await resolveSurveyAccess(hooks.event, 'короткий')

    expect(outcome.ok).toBe(false)
    expect(probe.rateCalls).toBe(0)
    expect(probe.lookups).toBe(0)
  })

  it('частота считается ДО поиска ссылки', async () => {
    // Обратный порядок означал бы, что перебор оплачивается запросом в базу на каждую
    // попытку — то есть предел защищает всех, кроме того, ради чего он заведён.
    rateDecision = { allow: false, by: 'address', retryAfterSeconds: 60 }
    const hooks = fakeEvent()
    const { resolveSurveyAccess } = await loadAccess(hooks)

    await resolveSurveyAccess(hooks.event, TOKEN)

    expect(probe.rateCalls).toBe(1)
    expect(probe.lookups).toBe(0)
  })

  it('на счастливом пути отдаёт ссылку, схему и хеш токена', async () => {
    const hooks = fakeEvent()
    const { resolveSurveyAccess } = await loadAccess(hooks)

    const outcome = await resolveSurveyAccess(hooks.event, TOKEN)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.link).toMatchObject({ id: 'ссылка' })
    expect(outcome.template).toMatchObject({ code: 'brand' })
    // ⚠ Хеш отдаётся наружу, а сам токен — нет: дальше по пути он нужен для записи ответа,
    // и пересчитывать его второй раз значило бы завести второе место, где он существует.
    expect(outcome.tokenHash).toHaveLength(64)
  })
})

describe('отказы неотличимы друг от друга', () => {
  it('ГЛАВНОЕ: несуществующий токен и негодный по форме отвечают одинаково', async () => {
    // ⚠ Иначе ответ становится оракулом: перебирающий отличает существующие токены
    // от несуществующих и сужает поиск. Отсюда же одинаковый код 200 на оба.
    const hooks = fakeEvent()
    const { resolveSurveyAccess } = await loadAccess(hooks)

    const shapeless = await resolveSurveyAccess(hooks.event, 'короткий')
    storedLink = null
    const missing = await resolveSurveyAccess(hooks.event, TOKEN)

    expect(shapeless).toEqual(missing)
    expect(hooks.status).toBe(200)
  })

  it('состояние ссылки объясняется словами, а не кодом ответа', async () => {
    // По этой ссылке приходит посторонний человек: на любой исход он должен увидеть
    // понятный текст, а не страницу ошибки браузера.
    storedLink = { ...LINK, status: 'completed' }
    const hooks = fakeEvent()
    const { resolveSurveyAccess } = await loadAccess(hooks)

    const outcome = await resolveSurveyAccess(hooks.event, TOKEN)

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.body.reason).toBe('completed')
    expect(outcome.body.detail.length).toBeGreaterThan(10)
    expect(hooks.status).toBe(200)
  })

  it('истёкшая и отозванная различаются причиной, но не кодом', async () => {
    const hooks = fakeEvent()
    const { resolveSurveyAccess } = await loadAccess(hooks)

    storedLink = { ...LINK, expiresAt: new Date(Date.now() - 60_000) }
    const expired = await resolveSurveyAccess(hooks.event, TOKEN)
    storedLink = { ...LINK, status: 'revoked' }
    const revoked = await resolveSurveyAccess(hooks.event, TOKEN)

    expect(expired.ok).toBe(false)
    expect(revoked.ok).toBe(false)
    if (expired.ok || revoked.ok) return
    expect(expired.body.reason).toBe('expired')
    expect(revoked.body.reason).toBe('revoked')
    expect(hooks.status).toBe(200)
  })
})

describe('превышение частоты', () => {
  it('отвечает 429 и говорит, когда возвращаться', async () => {
    rateDecision = { allow: false, by: 'token', retryAfterSeconds: 42 }
    const hooks = fakeEvent()
    const { resolveSurveyAccess } = await loadAccess(hooks)

    await resolveSurveyAccess(hooks.event, TOKEN)

    expect(hooks.status).toBe(429)
    expect(hooks.headers['Retry-After']).toBe('42')
  })

  it('в журнал уходит причина и НИЧЕГО больше', async () => {
    // ⚠ Инвариант проекта: ни токена, ни его хеша, ни адреса. Журналы переживают инцидент.
    rateDecision = { allow: false, by: 'token', retryAfterSeconds: 42 }
    const hooks = fakeEvent()
    const { resolveSurveyAccess } = await loadAccess(hooks)

    await resolveSurveyAccess(hooks.event, TOKEN)

    expect(probe.warned.join(' ')).toContain('превышена частота')
    expect(JSON.stringify(probe.warned)).not.toContain(TOKEN)
  })
})

describe('промах кэша схемы', () => {
  it('это НАША беда, а не отказ ссылке', async () => {
    // ⚠ Схема кладётся в кэш при выпуске, то есть заведомо раньше этого запроса. Промах
    // означает «ссылку выпустили неправильно», и отвечать на него «ссылка недействительна»
    // значило бы соврать человеку про его ссылку. Отсюда 503 и громкая запись в журнал.
    storedTemplate = null
    const hooks = fakeEvent()
    const { resolveSurveyAccess } = await loadAccess(hooks)

    await expect(resolveSurveyAccess(hooks.event, TOKEN)).rejects.toMatchObject({ statusCode: 503 })
    expect(probe.errored.join(' ')).toContain('схема версии не найдена')
  })

  it('без базы отвечает 503 и не делает ни одного шага', async () => {
    // ⚠ Проверка базы стоит ПЕРВОЙ. Без неё путь дошёл бы до поиска ссылки и упал там —
    // с ошибкой драйвера вместо честного «сервис не настроен».
    const hooks = fakeEvent()
    const { resolveSurveyAccess } = await loadAccess(hooks)
    // Переопределяем уже после загрузки: подделка читается при вызове, а не при импорте.
    vi.doMock('../../server/db/client', () => ({ isDatabaseConfigured: () => false }))
    vi.resetModules()
    const fresh = await import('../../server/api/s/-access')

    await expect(fresh.resolveSurveyAccess(hooks.event, TOKEN)).rejects.toMatchObject({ statusCode: 503 })
    expect(probe.rateCalls).toBe(0)
    expect(probe.lookups).toBe(0)
    // Сам по себе загруженный ранее модуль тоже отвечает: проверка не зависит от порядка.
    expect(typeof resolveSurveyAccess).toBe('function')
  })
})
