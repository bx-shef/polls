import { describe, expect, it } from 'vitest'
import { checkEnv, hasEnvIssues, type EnvReport } from '../src/obs/env-check'

/** Полный набор «всё хорошо» — от него отталкиваются точечные проверки. */
const GOOD: Record<string, string> = {
  DASHBOARD_AUTH_SECRET: 'a'.repeat(40),
  DATABASE_URL: 'postgres://polls:pw@db:5432/polls',
  NUXT_BITRIX_TOKEN_KEY: 'b'.repeat(64),
  NUXT_B24_CLIENT_ID: 'local.abc',
  NUXT_B24_CLIENT_SECRET: 'secret',
  DOMAIN: 'polls.bx-shef.by'
}
const prod = (over: Record<string, string | undefined> = {}): EnvReport =>
  checkEnv({ ...GOOD, ...over }, { isProduction: true })
const names = (list: { name: string }[]): string[] => list.map((i) => i.name)

describe('checkEnv — здоровое окружение', () => {
  it('полный прод-набор → ни ошибок, ни предупреждений', () => {
    const r = prod()
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
    expect(hasEnvIssues(r)).toBe(false)
  })

  it('вне прода режим памяти — это норма, а не ошибка', () => {
    const r = checkEnv({}, { isProduction: false })
    expect(names(r.errors)).not.toContain('DATABASE_URL')
    expect(names(r.warnings)).toContain('DATABASE_URL')
    // и секрет дашборда вне прода не требуется
    expect(names(r.errors)).not.toContain('DASHBOARD_AUTH_SECRET')
  })
})

describe('checkEnv — симптомы из таблицы «Если что-то пошло не так»', () => {
  it('нет секрета дашборда → ошибка (в бою это молчаливый 503)', () => {
    expect(names(prod({ DASHBOARD_AUTH_SECRET: undefined }).errors)).toContain('DASHBOARD_AUTH_SECRET')
  })

  it('короткий секрет → ошибка с указанием фактической длины', () => {
    const e = prod({ DASHBOARD_AUTH_SECRET: 'короткий' }).errors.find((i) => i.name === 'DASHBOARD_AUTH_SECRET')
    expect(e?.message).toMatch(/≥32/)
  })

  it('нет базы в проде → ошибка (данные исчезнут при перезапуске, вход всегда 401)', () => {
    const e = prod({ DATABASE_URL: undefined }).errors.find((i) => i.name === 'DATABASE_URL')
    expect(e?.message).toMatch(/исчезнут|401/)
  })

  it('ключ шифрования не 64 hex → ошибка', () => {
    expect(names(prod({ NUXT_BITRIX_TOKEN_KEY: 'abc' }).errors)).toContain('NUXT_BITRIX_TOKEN_KEY')
    expect(names(prod({ NUXT_BITRIX_TOKEN_KEY: 'z'.repeat(64) }).errors)).toContain('NUXT_BITRIX_TOKEN_KEY')
    expect(names(prod({ NUXT_BITRIX_TOKEN_KEY: 'B'.repeat(64) }).errors)).not.toContain('NUXT_BITRIX_TOKEN_KEY')
  })

  it('дашборд открыт без авторизации в проде → ошибка (утечка ПДн)', () => {
    const e = prod({ DASHBOARD_DEV_OPEN: '1' }).errors.find((i) => i.name === 'DASHBOARD_DEV_OPEN')
    expect(e?.message).toMatch(/БЕЗ авторизации/)
    // вне прода это штатный режим
    expect(names(checkEnv({ ...GOOD, DASHBOARD_DEV_OPEN: '1' }, { isProduction: false }).errors)).not.toContain('DASHBOARD_DEV_OPEN')
  })
})

describe('checkEnv — заглушки из наших же примеров', () => {
  it('незаполненные значения из .env.example ловятся', () => {
    expect(names(prod({ DASHBOARD_AUTH_SECRET: 'REPLACE_WITH__openssl_rand_hex_32' }).errors)).toContain('DASHBOARD_AUTH_SECRET')
    expect(names(prod({ NUXT_BITRIX_TOKEN_KEY: 'REPLACE_WITH__openssl_rand_hex_32' }).errors)).toContain('NUXT_BITRIX_TOKEN_KEY')
    expect(names(prod({ DOMAIN: 'polls.example.com' }).warnings)).toContain('DOMAIN')
    expect(names(prod({ GITHUB_FEEDBACK_TOKEN: 't', GITHUB_FEEDBACK_REPO: 'owner/private-inbox' }).warnings)).toContain('GITHUB_FEEDBACK_REPO')
  })
})

describe('checkEnv — половина пары', () => {
  it('только client_id или только secret → ошибка', () => {
    expect(names(prod({ NUXT_B24_CLIENT_SECRET: undefined }).errors)).toContain('NUXT_B24_CLIENT_SECRET')
    expect(names(prod({ NUXT_B24_CLIENT_ID: undefined }).errors)).toContain('NUXT_B24_CLIENT_ID')
  })

  it('обе не заданы → предупреждение, а не ошибка (это выбор режима)', () => {
    const r = prod({ NUXT_B24_CLIENT_ID: undefined, NUXT_B24_CLIENT_SECRET: undefined })
    expect(r.errors.every((i) => !i.name.includes('CLIENT'))).toBe(true)
    expect(names(r.warnings).join()).toContain('NUXT_B24_CLIENT_ID')
  })

  it('канал отзывов настроен наполовину → предупреждение', () => {
    expect(names(prod({ GITHUB_FEEDBACK_TOKEN: 't' }).warnings)).toContain('GITHUB_FEEDBACK_REPO')
    expect(names(prod({ GITHUB_FEEDBACK_REPO: 'owner/inbox' }).warnings)).toContain('GITHUB_FEEDBACK_TOKEN')
    expect(prod({ GITHUB_FEEDBACK_TOKEN: 't', GITHUB_FEEDBACK_REPO: 'owner/inbox' }).warnings).toEqual([])
  })
})

describe('checkEnv — значения, которые молча падают на умолчание', () => {
  it('нераспознанный режим триггера → предупреждение с перечнем допустимых', () => {
    const w = prod({ TRIGGER_MODE: 'robott' }).warnings.find((i) => i.name === 'TRIGGER_MODE')
    expect(w?.message).toMatch(/event, robot, both/)
    for (const v of ['event', 'ROBOT', 'both']) expect(prod({ TRIGGER_MODE: v }).warnings).toEqual([])
  })

  it('окно перехода вне диапазона → предупреждение', () => {
    for (const v of ['0', '4', '99999', 'abc']) expect(names(prod({ STAGE_ENTRY_WINDOW_SECONDS: v }).warnings)).toContain('STAGE_ENTRY_WINDOW_SECONDS')
    expect(prod({ STAGE_ENTRY_WINDOW_SECONDS: '60' }).warnings).toEqual([])
  })

  it('каденция обновления токенов вне диапазона → предупреждение', () => {
    expect(names(prod({ TOKEN_KEEPALIVE_HOURS: '0' }).warnings)).toContain('TOKEN_KEEPALIVE_HOURS')
    expect(prod({ TOKEN_KEEPALIVE_HOURS: '24' }).warnings).toEqual([])
  })

  it('нераспознанный уровень логов → предупреждение (частая опечатка warning вместо warn)', () => {
    expect(names(prod({ NUXT_LOG_LEVEL: 'warning' }).warnings)).toContain('NUXT_LOG_LEVEL')
    expect(prod({ NUXT_LOG_LEVEL: 'warn' }).warnings).toEqual([])
  })

  it('ослабленный режим CSP в проде → предупреждение «не забудьте вернуть»', () => {
    const w = prod({ CSP_MODE: 'report' }).warnings.find((i) => i.name === 'CSP_MODE')
    expect(w?.message).toMatch(/временная мера/)
    expect(prod({ CSP_MODE: 'enforce' }).warnings).toEqual([])
  })
})

describe('checkEnv — приватность отчёта', () => {
  it('НИ ОДНО значение переменной не попадает в отчёт', () => {
    // Иначе секрет уехал бы в лог при первом же запуске.
    const secret = 'СЕКРЕТНОЕ-ЗНАЧЕНИЕ-КОТОРОГО-НЕ-ДОЛЖНО-БЫТЬ-В-ЛОГЕ'
    const r = checkEnv(
      {
        DASHBOARD_AUTH_SECRET: secret,
        NUXT_BITRIX_TOKEN_KEY: secret,
        DATABASE_URL: `postgres://user:${secret}@db/polls`,
        GITHUB_FEEDBACK_TOKEN: secret,
        TRIGGER_MODE: secret
      },
      { isProduction: true }
    )
    const dump = JSON.stringify(r)
    expect(dump).not.toContain(secret)
    expect(dump).not.toContain('СЕКРЕТНОЕ')
  })

  it('длина секрета в сообщении есть, а сам секрет — нет', () => {
    const e = prod({ DASHBOARD_AUTH_SECRET: 'abcdefghij' }).errors.find((i) => i.name === 'DASHBOARD_AUTH_SECRET')
    expect(e?.message).toContain('10')
    expect(e?.message).not.toContain('abcdefghij')
  })
})

describe('hasEnvIssues', () => {
  it('пустой отчёт → false (при здоровом окружении в лог ничего не пишем)', () => {
    expect(hasEnvIssues({ errors: [], warnings: [] })).toBe(false)
    expect(hasEnvIssues({ errors: [], warnings: [{ name: 'X', message: 'y' }] })).toBe(true)
  })
})
