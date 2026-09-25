import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Стык с SDK: `server/b24/client.ts` (issue #13).
 *
 * ⚠ САМОЕ ДОРОГОЕ ЗДЕСЬ — инвариант «встроенный ретрай SDK выключен». Сегодня он держится
 * на строке `maxRetries: 1` и на том, что её никто не тронет. Опечатка в имени параметра
 * конструктора не обязана пойматься TypeScript, если типы SDK достаточно широкие, — и тогда
 * ретрай тихо останется включённым по умолчанию. Последствие конкретное: `crm.type.add`,
 * повторённый транспортом после таймаута, создаёт ВТОРОЙ смарт-процесс при лимите 150
 * на весь портал. Ни сборка, ни типы этого не покажут.
 *
 * ⚠ Приём — структурно типизированная подделка SDK, как и советовал issue: мок модуля
 * `@bitrix24/b24jssdk` запоминает, что уехало в конструктор. Мок `getDb()` при этом
 * не нужен вовсе — здесь нет ни одного обращения к базе.
 */

/** Что уехало в конструктор `B24OAuth` и что с клиентом делали дальше. */
interface SdkProbe {
  auth: Record<string, unknown>
  credentials: Record<string, unknown>
  options: Record<string, unknown>
  refreshCallback?: (payload: { b24OAuthParams: Record<string, unknown> }) => Promise<void>
}

const probe: { last?: SdkProbe } = {}

vi.mock('@bitrix24/b24jssdk', () => ({
  B24OAuth: class {
    constructor(auth: Record<string, unknown>, credentials: Record<string, unknown>, options: Record<string, unknown>) {
      probe.last = { auth, credentials, options }
    }

    setCallbackRefreshAuth(callback: (payload: { b24OAuthParams: Record<string, unknown> }) => Promise<void>) {
      probe.last!.refreshCallback = callback
    }

    actions = { v2: { call: { make: async () => ({ isSuccess: true, getData: () => ({ result: true }) }) } } }
  },
  // Подделки ради импорта: сам модуль их только упоминает.
  LoggerBrowser: { build: () => ({}) },
  LoggerType: {},
}))

const AUTH = {
  memberId: 'a223c6b3710f85df22e9377d6c4f7553',
  domain: 'shef.bitrix24.ru',
  accessToken: 'токен-доступа',
  refreshToken: 'грант',
  applicationToken: 'токен-приложения',
  expiresIn: 3600,
  scope: ['crm', 'im'],
}

/** Модуль читает пару приложения из окружения — без неё конструктор до подделки не дойдёт. */
function withCredentials() {
  vi.stubEnv('B24_CLIENT_ID', 'app.123')
  vi.stubEnv('B24_CLIENT_SECRET', 'секрет-приложения')
}

afterEach(() => {
  vi.unstubAllEnvs()
  probe.last = undefined
})

describe('конструктор клиента', () => {
  it('ГЛАВНОЕ: встроенный ретрай выключен', async () => {
    // ⚠ Инвариант проекта. Вызовы создания не идемпотентны, и слепой повтор транспортом
    // плодит дубли: второй смарт-процесс при лимите 150 на портал — необратимо и заметно
    // не сразу. Проверяется именно ФАКТ ПОПАДАНИЯ значения в конструктор SDK, потому что
    // опечатка в имени параметра компилируется молча.
    withCredentials()
    const { makePortalCall } = await import('../../server/b24/client')

    makePortalCall(AUTH)

    const restriction = (probe.last!.options.restrictionParams ?? {}) as Record<string, unknown>
    expect(restriction.maxRetries).toBe(1)
  })

  it('повтор по сетевой ошибке выключен отдельно', async () => {
    // ⚠ Избыточно при `maxRetries: 1` — ветка повтора недостижима. Стоит явно, чтобы
    // поднятие числа попыток не включило заодно и повтор по обрыву: именно он и создаёт
    // второй смарт-процесс после таймаута.
    withCredentials()
    const { makePortalCall } = await import('../../server/b24/client')

    makePortalCall(AUTH)

    const restriction = (probe.last!.options.restrictionParams ?? {}) as Record<string, unknown>
    expect(restriction.retryOnNetworkError).toBe(false)
  })

  it('адрес портала собирается из его домена, а не из константы', async () => {
    // Клиент один на все порталы, и перепутанный адрес означал бы вызовы в чужой портал.
    withCredentials()
    const { makePortalCall } = await import('../../server/b24/client')

    makePortalCall(AUTH)

    expect(probe.last!.auth.clientEndpoint).toBe('https://shef.bitrix24.ru/rest/')
    expect(probe.last!.auth.memberId).toBe(AUTH.memberId)
  })

  it('пара приложения уходит отдельным аргументом, а не в токенах', async () => {
    // `client_secret` не должен смешиваться с данными портала: это наш секрет,
    // а не его.
    withCredentials()
    const { makePortalCall } = await import('../../server/b24/client')

    makePortalCall(AUTH)

    expect(probe.last!.credentials).toMatchObject({ clientId: 'app.123', clientSecret: 'секрет-приложения' })
    expect(JSON.stringify(probe.last!.auth)).not.toContain('секрет-приложения')
  })
})

describe('автоматическое продление токенов', () => {
  it('ГЛАВНОЕ: сохраняет новую пару, а не только читает её', async () => {
    // ⚠ SDK продлевает токены сам, и если не сохранить их, следующий запуск пойдёт
    // с МЁРТВОЙ парой: прежний `refresh_token` после обмена недействителен. Беда
    // проявится не сразу и будет выглядеть как «приложение перестало работать само собой».
    withCredentials()
    const { makePortalCall } = await import('../../server/b24/client')
    const saved: unknown[] = []

    makePortalCall(AUTH, async next => void saved.push(next))
    await probe.last!.refreshCallback!({
      b24OAuthParams: { accessToken: 'новый-доступ', refreshToken: 'новый-грант', expiresIn: '7200' },
    })

    expect(saved).toEqual([{ accessToken: 'новый-доступ', refreshToken: 'новый-грант', expiresIn: 7200 }])
  })

  it('срок жизни читается числом, даже когда пришёл строкой', async () => {
    // ⚠ SDK отдаёт `expiresIn` строкой. Записав её как есть, мы получили бы дату,
    // посчитанную из `NaN`, — то есть токен, просроченный в момент сохранения.
    withCredentials()
    const { makePortalCall } = await import('../../server/b24/client')
    const saved: { expiresIn: number }[] = []

    makePortalCall(AUTH, async next => void saved.push(next))
    await probe.last!.refreshCallback!({
      b24OAuthParams: { accessToken: 'a', refreshToken: 'b', expiresIn: 'не число' },
    })

    // Час по умолчанию — лучше, чем `NaN`: продление случится раньше, чем нужно,
    // но случится.
    expect(saved[0]!.expiresIn).toBe(3600)
  })

  it('без обработчика продления колбэк не ставится вовсе', async () => {
    // Иначе SDK звал бы `undefined` и ронял вызов, которому продление было не нужно.
    withCredentials()
    const { makePortalCall } = await import('../../server/b24/client')

    makePortalCall(AUTH)

    expect(probe.last!.refreshCallback).toBeUndefined()
  })
})
