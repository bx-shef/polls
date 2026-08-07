import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { checkEnv, hasEnvIssues, type EnvReport } from '../src/obs/env-check'
import { TRIGGER_MODES } from '../src/bitrix24/trigger-mode'
import { CSP_MODES } from '../src/api/security-headers'
import { LOG_LEVELS } from '../src/obs/logger'
import { MIN_SECRET_LEN } from '../src/api/session'
import { STAGE_ENTRY_WINDOW_MAX_SEC, STAGE_ENTRY_WINDOW_MIN_SEC } from '../src/bitrix24/stage-transition'
import { DEFAULT_KEEPALIVE_HOURS, MAX_KEEPALIVE_HOURS, MIN_KEEPALIVE_HOURS } from '../src/bitrix24/keep-alive'

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

  it('dev-открытость при ГОДНОМ секрете — не ошибка: секрет её перекрывает', () => {
    // Первая версия проверки поднимала здесь самое громкое сообщение об утечке ПДн, которой НЕТ:
    // `resolveDashboardAuth` возвращается раньше, если секрет задан. От ложных тревог люди
    // перестают читать лог целиком — поэтому это предупреждение «уберите, она не действует».
    const r = prod({ DASHBOARD_DEV_OPEN: '1' })
    expect(names(r.errors)).not.toContain('DASHBOARD_DEV_OPEN')
    expect(r.warnings.find((i) => i.name === 'DASHBOARD_DEV_OPEN')?.message).toMatch(/НЕ действует/)
  })

  it('dev-открытость БЕЗ годного секрета в проде → ошибка: она реально действует', () => {
    const e = prod({ DASHBOARD_DEV_OPEN: '1', DASHBOARD_AUTH_SECRET: undefined }).errors.find(
      (i) => i.name === 'DASHBOARD_DEV_OPEN'
    )
    expect(e?.message).toMatch(/БЕЗ авторизации/)
    // вне прода это штатный режим разработки
    expect(
      names(checkEnv({ ...GOOD, DASHBOARD_AUTH_SECRET: undefined, DASHBOARD_DEV_OPEN: '1' }, { isProduction: false }).errors)
    ).not.toContain('DASHBOARD_DEV_OPEN')
  })

  it('пробел в значении флага тоже включает dev-режим — тримить нельзя', () => {
    // Сервер читает `!!process.env.DASHBOARD_DEV_OPEN`: непустая строка из пробела — тоже включено.
    const r = prod({ DASHBOARD_DEV_OPEN: ' ' })
    expect(names(r.warnings)).toContain('DASHBOARD_DEV_OPEN')
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

describe('checkEnv — пороги берутся из тех же модулей, что решают в бою', () => {
  it('диапазон окна перехода совпадает с резолвером', () => {
    // Дрейф здесь = проверка врёт пользователю. Поэтому сверяем с константами, а не с числами.
    expect(names(prod({ STAGE_ENTRY_WINDOW_SECONDS: String(STAGE_ENTRY_WINDOW_MIN_SEC) }).warnings)).not.toContain('STAGE_ENTRY_WINDOW_SECONDS')
    expect(names(prod({ STAGE_ENTRY_WINDOW_SECONDS: String(STAGE_ENTRY_WINDOW_MIN_SEC - 1) }).warnings)).toContain('STAGE_ENTRY_WINDOW_SECONDS')
    expect(names(prod({ STAGE_ENTRY_WINDOW_SECONDS: String(STAGE_ENTRY_WINDOW_MAX_SEC + 1) }).warnings)).toContain('STAGE_ENTRY_WINDOW_SECONDS')
  })

  it('порог длины секрета совпадает с isStrongSecret', () => {
    expect(names(prod({ DASHBOARD_AUTH_SECRET: 'a'.repeat(MIN_SECRET_LEN) }).errors)).not.toContain('DASHBOARD_AUTH_SECRET')
    expect(names(prod({ DASHBOARD_AUTH_SECRET: 'a'.repeat(MIN_SECRET_LEN - 1) }).errors)).toContain('DASHBOARD_AUTH_SECRET')
  })

  it('число вне диапазона ПРИЖИМАЕТСЯ к границе, а не падает на умолчание — так и сказано', () => {
    // Прежний текст обещал «используется 24», хотя keepAliveIntervalMs даёт 168 для 500 и 1 для 0.5.
    // Две самые вероятные опечатки получали неверный диагноз.
    expect(prod({ TOKEN_KEEPALIVE_HOURS: '500' }).warnings.find((i) => i.name === 'TOKEN_KEEPALIVE_HOURS')?.message).toContain(
      String(MAX_KEEPALIVE_HOURS)
    )
    expect(prod({ TOKEN_KEEPALIVE_HOURS: '0.5' }).warnings.find((i) => i.name === 'TOKEN_KEEPALIVE_HOURS')?.message).toContain(
      String(MIN_KEEPALIVE_HOURS)
    )
    expect(prod({ TOKEN_KEEPALIVE_HOURS: 'abc' }).warnings.find((i) => i.name === 'TOKEN_KEEPALIVE_HOURS')?.message).toContain(
      String(DEFAULT_KEEPALIVE_HOURS)
    )
  })
})

describe('checkEnv — расхождения, найденные ревью на живом коде', () => {
  it('ПУСТОЙ APP_DOMAIN затеняет рабочий DOMAIN → ошибка', () => {
    // Приложение берёт `APP_DOMAIN ?? DOMAIN` через `??`: пустая, но заданная переменная побеждает,
    // адрес остаётся пустым и установка отдаёт 503. Типовой случай — раскомментировали и не заполнили.
    const e = prod({ APP_DOMAIN: '' }).errors.find((i) => i.name === 'APP_DOMAIN')
    expect(e?.message).toMatch(/ЗАТЕНЯЕТ DOMAIN/)
    // заполненный APP_DOMAIN — норма
    expect(names(prod({ APP_DOMAIN: 'polls.bx-shef.by' }).errors)).not.toContain('APP_DOMAIN')
  })

  it('уровень логов регистрозависим: WARN молча откатится на info', () => {
    expect(names(prod({ NUXT_LOG_LEVEL: 'WARN' }).warnings)).toContain('NUXT_LOG_LEVEL')
    expect(names(prod({ NUXT_LOG_LEVEL: ' warn' }).warnings)).toContain('NUXT_LOG_LEVEL')
    expect(prod({ NUXT_LOG_LEVEL: 'warn' }).warnings).toEqual([])
  })

  it('приоритетная переменная LOG_LEVEL тоже проверяется', () => {
    // Иначе опечатка в ней погасила бы часть этого же отчёта.
    expect(names(prod({ LOG_LEVEL: 'warning' }).warnings)).toContain('LOG_LEVEL')
  })

  it('заглушка ВНУТРИ строки подключения ловится (прод с паролем по умолчанию)', () => {
    const e = prod({ DATABASE_URL: 'postgres://polls:CHANGE_ME@localhost:5432/polls' }).errors.find((i) => i.name === 'DATABASE_URL')
    expect(e?.message).toMatch(/заглушка/)
  })

  it('ключ из одних нулей отвергается, хотя по формату он валиден', () => {
    expect(names(prod({ NUXT_BITRIX_TOKEN_KEY: '0'.repeat(64) }).errors)).toContain('NUXT_BITRIX_TOKEN_KEY')
  })

  it('один секрет на две роли → предупреждение', () => {
    const same = 'c'.repeat(64)
    expect(names(prod({ DASHBOARD_AUTH_SECRET: same, NUXT_BITRIX_TOKEN_KEY: same }).warnings).join()).toContain('DASHBOARD_AUTH_SECRET')
  })

  it('непригодные источники frame-ancestors ловятся (иначе пустой фрейм при 200 в логах)', () => {
    const w = prod({ CSP_FRAME_ANCESTORS: 'https://ok.local, crm.acme.local, https://*' }).warnings.find(
      (i) => i.name === 'CSP_FRAME_ANCESTORS'
    )
    expect(w?.message).toMatch(/2 из 3/)
    expect(prod({ CSP_FRAME_ANCESTORS: 'https://a.local https://*.b.local' }).warnings).toEqual([])
  })

  it('репозиторий отзывов не в виде владелец/репозиторий → предупреждение', () => {
    expect(names(prod({ GITHUB_FEEDBACK_TOKEN: 't', GITHUB_FEEDBACK_REPO: 'inbox' }).warnings)).toContain('GITHUB_FEEDBACK_REPO')
  })

  it('боевое окружение мимо прод-образа (NODE_ENV не production) → предупреждение', () => {
    const w = checkEnv(GOOD, { isProduction: false }).warnings.find((i) => i.name === 'NODE_ENV')
    expect(w?.message).toMatch(/выглядит боевым/)
    // пустое окружение таким не выглядит — молчим
    expect(names(checkEnv({}, { isProduction: false }).warnings)).not.toContain('NODE_ENV')
  })
})

describe('checkEnv — приватность отчёта, структурно', () => {
  it('НИ ОДНО значение НИ ОДНОЙ переменной не попадает в отчёт', () => {
    // Каждой переменной — уникальный сентинел; затем ищем их все разом. Прежний тест гонял
    // 5 переменных из ~18 и не покрывал CSP_MODE — единственное место с интерполяцией значения.
    const vars = [
      'DASHBOARD_AUTH_SECRET', 'DASHBOARD_DEV_OPEN', 'DATABASE_URL', 'POSTGRES_PASSWORD',
      'NUXT_BITRIX_TOKEN_KEY', 'NUXT_B24_CLIENT_ID', 'NUXT_B24_CLIENT_SECRET', 'APP_DOMAIN', 'DOMAIN',
      'TRIGGER_MODE', 'STAGE_ENTRY_WINDOW_SECONDS', 'TOKEN_KEEPALIVE_HOURS', 'LOG_LEVEL',
      'NUXT_LOG_LEVEL', 'CSP_MODE', 'CSP_FRAME_ANCESTORS', 'GITHUB_FEEDBACK_TOKEN', 'GITHUB_FEEDBACK_REPO'
    ]
    const env: Record<string, string> = {}
    vars.forEach((v, i) => (env[v] = `сентинел${i}значение`))
    for (const isProduction of [true, false]) {
      const dump = JSON.stringify(checkEnv(env, { isProduction }))
      const low = dump.toLowerCase()
      for (const v of vars) {
        // Сверяем в ОБОИХ регистрах: модуль местами лоуэркейсит значения, и утёкшая строка
        // не поймалась бы регистрозависимым сравнением.
        expect(dump, `${v} при isProduction=${isProduction}`).not.toContain(env[v]!)
        expect(low, `${v} (в нижнем регистре) при isProduction=${isProduction}`).not.toContain(env[v]!.toLowerCase())
      }
    }
  })
})

describe('checkEnv — полный отчёт на пустом окружении (защита от пропажи проверок)', () => {
  it('в проде набор ошибок и предупреждений ТОЧНО такой', () => {
    // Точный набор, а не toContain: иначе удаление целой проверки не роняет ни одного теста —
    // ровно это показала мутационная проверка на первой версии.
    const r = checkEnv({}, { isProduction: true })
    expect(names(r.errors)).toEqual(['DASHBOARD_AUTH_SECRET', 'DATABASE_URL'])
    expect(names(r.warnings)).toEqual(['NUXT_BITRIX_TOKEN_KEY', 'NUXT_B24_CLIENT_ID', 'APP_DOMAIN'])
  })

  it('вне прода — только предупреждения, ошибок нет', () => {
    const r = checkEnv({}, { isProduction: false })
    expect(r.errors).toEqual([])
    expect(names(r.warnings)).toEqual(['DATABASE_URL', 'NUXT_BITRIX_TOKEN_KEY', 'NUXT_B24_CLIENT_ID', 'APP_DOMAIN'])
  })
})

describe('checkEnv — границы и перечни целиком', () => {
  it('формат ключа шифрования: длина ровно 64 и только hex', () => {
    expect(names(prod({ NUXT_BITRIX_TOKEN_KEY: 'a'.repeat(64) }).errors)).not.toContain('NUXT_BITRIX_TOKEN_KEY')
    for (const k of ['a'.repeat(63), 'a'.repeat(65), `${'a'.repeat(63)}x`, ` ${'a'.repeat(64)}x`]) {
      expect(names(prod({ NUXT_BITRIX_TOKEN_KEY: k }).errors), k.length.toString()).toContain('NUXT_BITRIX_TOKEN_KEY')
    }
  })

  it('границы диапазонов включительные', () => {
    for (const v of [String(STAGE_ENTRY_WINDOW_MIN_SEC), String(STAGE_ENTRY_WINDOW_MAX_SEC)]) {
      expect(names(prod({ STAGE_ENTRY_WINDOW_SECONDS: v }).warnings), v).not.toContain('STAGE_ENTRY_WINDOW_SECONDS')
    }
    for (const v of [String(MIN_KEEPALIVE_HOURS), String(MAX_KEEPALIVE_HOURS)]) {
      expect(names(prod({ TOKEN_KEEPALIVE_HOURS: v }).warnings), v).not.toContain('TOKEN_KEEPALIVE_HOURS')
    }
    expect(names(prod({ TOKEN_KEEPALIVE_HOURS: String(MAX_KEEPALIVE_HOURS + 1) }).warnings)).toContain('TOKEN_KEEPALIVE_HOURS')
  })

  it('все допустимые значения перечней проходят молча', () => {
    for (const v of LOG_LEVELS) expect(prod({ NUXT_LOG_LEVEL: v }).warnings, v).toEqual([])
    for (const v of TRIGGER_MODES) expect(prod({ TRIGGER_MODE: v }).warnings, v).toEqual([])
    for (const v of CSP_MODES) {
      const w = names(prod({ CSP_MODE: v }).warnings)
      if (v === 'enforce') expect(w).toEqual([])
      else expect(w).toEqual(['CSP_MODE']) // ослабленный режим в проде — напоминание
    }
  })

  it('нераспознанный режим CSP → «не распознано», а не «защита ослаблена»', () => {
    const w = prod({ CSP_MODE: 'reprot' }).warnings.find((i) => i.name === 'CSP_MODE')
    expect(w?.message).toMatch(/не распознано/)
    // вне прода ослабленный режим — норма разработки, молчим
    expect(names(checkEnv({ ...GOOD, CSP_MODE: 'report' }, { isProduction: false }).warnings)).not.toContain('CSP_MODE')
  })
})

describe('плагин проверки окружения — гард по исходнику (server/** тестами не покрывается)', () => {
  const src = readFileSync(resolve(process.cwd(), 'server/plugins/env-check.ts'), 'utf8')

  it('строгость привязана к NODE_ENV — без неё прод-ошибки станут предупреждениями', () => {
    expect(src).toContain("isProduction: process.env.NODE_ENV === 'production'")
  })

  it('ошибки идут в error, предупреждения в warn — иначе прод-ошибка утонет', () => {
    expect(src).toMatch(/report\.errors[\s\S]*logger\.error/)
    expect(src).toMatch(/report\.warnings[\s\S]*logger\.warn/)
  })

  it('при здоровом окружении молчит', () => {
    expect(src).toContain('if (!hasEnvIssues(report)) return')
  })

  it('в лог не выгружается окружение целиком', () => {
    expect(src).not.toContain('JSON.stringify(process.env)')
    expect(src).not.toMatch(/logger\.(error|warn)\([^)]*process\.env[^)]*\)/)
  })
})
