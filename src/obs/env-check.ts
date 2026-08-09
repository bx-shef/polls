import { MIN_SECRET_LEN } from '../api/session'
import { STAGE_ENTRY_WINDOW_MAX_SEC, STAGE_ENTRY_WINDOW_MIN_SEC } from '../bitrix24/stage-transition'
import { MAX_KEEPALIVE_HOURS, MIN_KEEPALIVE_HOURS, DEFAULT_KEEPALIVE_HOURS } from '../bitrix24/keep-alive'
import { TRIGGER_MODES } from '../bitrix24/trigger-mode'
import { CSP_MODES } from '../api/security-headers'
import { LOG_LEVELS } from './logger'
import { telemetryEnabled } from './telemetry'
import { resolveTrustedProxies, MAX_TRUSTED_PROXIES } from '../api/client-ip'
import { DEFAULT_TOMBSTONE_DAYS, MAX_TOMBSTONE_DAYS, MIN_TOMBSTONE_DAYS } from '../bitrix24/portal'

/**
 * Проверка окружения при старте.
 *
 * **Зачем.** Половина строк таблицы «Если что-то пошло не так» (карта проекта) — это неверная
 * переменная окружения. Сегодня такая ошибка обнаруживается уже в бою и выглядит непонятно: дашборд
 * молча отдаёт 503, установка молча отдаёт 503, данные молча исчезают после перезапуска. Человек видит
 * симптом, а не причину. Впереди первый живой прогон на портале — там цена такой отладки самая высокая.
 *
 * ⚠️ **Главный риск этого модуля — соврать.** Диагностика, которая указывает не на ту причину, хуже её
 * отсутствия: человек уходит искать несуществующую проблему. Поэтому пороги и перечни здесь НЕ
 * переписаны заново, а **импортированы** из тех же модулей, что принимают решения в бою
 * (`MIN_SECRET_LEN`, границы окна и каденции, списки режимов). Если завтра порог изменят — сообщение
 * изменится вместе с ним, а не начнёт врать.
 *
 * **Не роняем процесс.** Часть переменных фатальна и без нас, а остальное — выбор режима: без
 * `DATABASE_URL` приложение осознанно работает на памяти. Наша задача — назвать последствия вслух.
 *
 * Отдельно рассматривали предложение падать на одной конкретной комбинации — `production` + действующая
 * dev-открытость (там чтение персональных данных реально открыто анониму, и приложение само себя не
 * закрывает). **Не делаем**, и вот почему: документированное демо (`docker compose up --build app`)
 * даёт ровно эту комбинацию — образ ставит `NODE_ENV=production`, базовый compose включает
 * `DASHBOARD_DEV_OPEN=1` и не требует секрета. Падение на старте сломало бы штатный способ показать
 * сервис. Отличить «демо» от «прода, который забыли настроить» по окружению мы не можем, поэтому
 * говорим громко (`error`), но работать не мешаем.
 *
 * ⚠️ Логируем **имена** переменных и характер проблемы, НИКОГДА значения: там секреты.
 */

export interface EnvIssue {
  /** Имя переменной, к которой относится замечание. */
  name: string
  /** Что не так и чем это обернётся — человеческим языком. */
  message: string
}

export interface EnvReport {
  /** Не заработает то, ради чего переменная нужна. */
  errors: EnvIssue[]
  /** Заработает, но не так, как ожидает владелец. */
  warnings: EnvIssue[]
}

export interface EnvCheckOptions {
  /** Прод ли это: часть замечаний осмысленна только там (в разработке режим памяти — норма). */
  isProduction?: boolean
}

/** Значения-заглушки из наших же примеров: если такое доехало до прода — переменную не заполнили. */
const PLACEHOLDERS = [
  'replace_with__openssl_rand_hex_32',
  'replace_with_strong_password',
  'change_me',
  'changeme',
  'todo',
  'xxx',
  'owner/private-inbox',
  'polls.example.com',
  'admin@example.com'
]

const isPlaceholder = (v: string): boolean => PLACEHOLDERS.includes(v.trim().toLowerCase())

/**
 * Заглушка МОЖЕТ сидеть внутри значения, а не быть им целиком: `.env.example` раздаёт
 * `DATABASE_URL=postgres://polls:CHANGE_ME@localhost:5432/polls`. Сравнение целиком такое пропускало,
 * и прод с паролем по умолчанию проходил проверку молча.
 */
const containsPlaceholder = (v: string): boolean => {
  const low = v.toLowerCase()
  return PLACEHOLDERS.some((p) => p.length > 4 && low.includes(p))
}

/** 64 hex-символа = 32 байта ключа AES-256 (формат, который принимает загрузчик ключа). */
const HEX64 = /^[0-9a-f]{64}$/i

/** Ключ из одних нулей — валиден по формату, но это явно не сгенерированный ключ. */
const isNullKey = (v: string): boolean => /^0+$/.test(v)

/**
 * Проверить окружение. Чистая функция: окружение передаётся аргументом, наружу — только отчёт.
 * Поэтому проверяется юнит-тестами без подмены `process.env`.
 */
export function checkEnv(env: Record<string, string | undefined>, opts: EnvCheckOptions = {}): EnvReport {
  const errors: EnvIssue[] = []
  const warnings: EnvIssue[] = []
  const prod = opts.isProduction === true
  const val = (n: string): string => (env[n] ?? '').trim()
  const set = (n: string): boolean => (env[n] ?? '') !== '' // приложение читает флаги как !!value

  // ── Дашборд (контур B) ───────────────────────────────────────────────────────────────────
  // ⚠️ Длину меряем по СЫРОМУ значению: `isStrongSecret` тоже не тримит. Секрет из 31 символа с
  // переводом строки из env-файла приложение принимает — ругаться на него было бы ложной тревогой.
  const secret = env['DASHBOARD_AUTH_SECRET'] ?? ''
  const secretOk = secret.length >= MIN_SECRET_LEN && !isPlaceholder(secret)
  if (!secret) {
    if (prod) {
      errors.push({
        name: 'DASHBOARD_AUTH_SECRET',
        message: `не задан — дашборд будет отдавать 503, а вход из Bitrix24 не заработает. Задайте ≥${MIN_SECRET_LEN} символов: openssl rand -hex 32`
      })
    }
  } else if (isPlaceholder(secret)) {
    errors.push({
      name: 'DASHBOARD_AUTH_SECRET',
      message: 'осталось значение-заглушка из примера — дашборд будет отдавать 503. Замените на настоящий секрет: openssl rand -hex 32'
    })
  } else if (secret.length < MIN_SECRET_LEN) {
    errors.push({
      name: 'DASHBOARD_AUTH_SECRET',
      message: `слишком короткий (${secret.length} символов, нужно ≥${MIN_SECRET_LEN}) — дашборд будет отдавать 503`
    })
  }

  // ⚠️ Секрет ИМЕЕТ ПРИОРИТЕТ над dev-открытостью (`resolveDashboardAuth`). Пока это не учитывалось,
  // штатный прод получал самое громкое сообщение об утечке персональных данных, которой нет, — а от
  // ложных тревог люди перестают читать лог целиком.
  if (set('DASHBOARD_DEV_OPEN')) {
    if (secretOk) {
      warnings.push({
        name: 'DASHBOARD_DEV_OPEN',
        message: 'переменная задана, но НЕ действует: заданный DASHBOARD_AUTH_SECRET её перекрывает. Уберите её, чтобы не вводила в заблуждение'
      })
    } else if (prod) {
      errors.push({
        name: 'DASHBOARD_DEV_OPEN',
        message: 'включён в production и действует (нет годного DASHBOARD_AUTH_SECRET) — дашборд открыт БЕЗ авторизации, наружу уйдут имена клиентов и ответственных. Задайте секрет и уберите эту переменную'
      })
    }
  }

  // ── Хранилище ────────────────────────────────────────────────────────────────────────────
  const db = val('DATABASE_URL')
  if (!db) {
    const message =
      'не задан — приложение работает на временном хранилище в памяти: все ответы исчезнут при перезапуске, а вход из Bitrix24 будет всегда отдавать 401. Задайте строку подключения к PostgreSQL'
    if (prod) errors.push({ name: 'DATABASE_URL', message })
    else warnings.push({ name: 'DATABASE_URL', message })
  } else if (containsPlaceholder(db)) {
    errors.push({
      name: 'DATABASE_URL',
      message: 'внутри строки подключения осталось значение-заглушка из примера (пароль базы не заменён) — замените его'
    })
  }
  const pgPassword = val('POSTGRES_PASSWORD')
  if (pgPassword && isPlaceholder(pgPassword)) {
    errors.push({ name: 'POSTGRES_PASSWORD', message: 'осталось значение-заглушка из примера — задайте настоящий пароль базы' })
  }

  // ── Связка с Bitrix24 ────────────────────────────────────────────────────────────────────
  const tokenKey = val('NUXT_BITRIX_TOKEN_KEY')
  if (!tokenKey) {
    warnings.push({
      name: 'NUXT_BITRIX_TOKEN_KEY',
      message: 'не задан — связка с порталом выключена: установка будет отдавать 503 (нечем шифровать токены). Задайте 64 hex: openssl rand -hex 32'
    })
  } else if (isPlaceholder(tokenKey)) {
    errors.push({
      name: 'NUXT_BITRIX_TOKEN_KEY',
      message: 'осталось значение-заглушка из примера — установка будет отдавать 503. Задайте 64 hex: openssl rand -hex 32'
    })
  } else if (!HEX64.test(tokenKey)) {
    errors.push({
      name: 'NUXT_BITRIX_TOKEN_KEY',
      message: `должен быть ровно 64 hex-символа (сейчас ${tokenKey.length}) — установка будет отдавать 503`
    })
  } else if (isNullKey(tokenKey)) {
    errors.push({ name: 'NUXT_BITRIX_TOKEN_KEY', message: 'состоит из одних нулей — это не сгенерированный ключ. Задайте: openssl rand -hex 32' })
  }

  if (secretOk && tokenKey && secret === tokenKey) {
    warnings.push({
      name: 'DASHBOARD_AUTH_SECRET / NUXT_BITRIX_TOKEN_KEY',
      message: 'один и тот же секрет используется для двух разных задач — сгенерируйте отдельные значения'
    })
  }

  const hasId = !!val('NUXT_B24_CLIENT_ID')
  const hasSecret = !!val('NUXT_B24_CLIENT_SECRET')
  if (hasId !== hasSecret) {
    errors.push({
      name: hasId ? 'NUXT_B24_CLIENT_SECRET' : 'NUXT_B24_CLIENT_ID',
      message: `не задан, хотя ${hasId ? 'NUXT_B24_CLIENT_ID' : 'NUXT_B24_CLIENT_SECRET'} задан — связка с порталом не заработает. Нужны обе переменные`
    })
  } else if (!hasId) {
    warnings.push({
      name: 'NUXT_B24_CLIENT_ID',
      message: 'не заданы NUXT_B24_CLIENT_ID и NUXT_B24_CLIENT_SECRET — связка с порталом выключена: установка и фоновое обновление токенов работать не будут'
    })
  }

  // ⚠️ Приложение берёт `APP_DOMAIN ?? DOMAIN` — через `??`, а не `||`. Значит ПУСТОЙ, но заданный
  // `APP_DOMAIN` (типовой случай: раскомментировали строку из примера и не заполнили) затеняет рабочий
  // `DOMAIN`, и установка начинает отдавать 503. Воспроизводим ту же семантику по сырым значениям.
  const rawAppDomain = env['APP_DOMAIN']
  const appDomain = val('APP_DOMAIN')
  const domain = val('DOMAIN')
  if (rawAppDomain !== undefined && !appDomain && domain) {
    errors.push({
      name: 'APP_DOMAIN',
      message: 'задан пустым и ЗАТЕНЯЕТ DOMAIN — адрес приложения останется пустым, установка будет отдавать 503. Заполните APP_DOMAIN или уберите строку целиком'
    })
  } else if (!appDomain && !domain) {
    warnings.push({
      name: 'APP_DOMAIN',
      message: 'не задан домен приложения (ни APP_DOMAIN, ни DOMAIN) — ссылки-приглашения и адреса встроек соберутся неверно. Укажите домен без схемы'
    })
  } else {
    for (const [name, v] of [
      ['APP_DOMAIN', appDomain],
      ['DOMAIN', domain]
    ] as const) {
      if (v && isPlaceholder(v)) {
        warnings.push({ name, message: 'осталось значение-заглушка из примера — укажите настоящий домен приложения' })
      }
    }
  }

  // ── Поведение: мусор здесь молча падает на умолчание, поэтому предупреждаем ───────────────
  const mode = val('TRIGGER_MODE').toLowerCase()
  if (mode && !(TRIGGER_MODES as readonly string[]).includes(mode)) {
    warnings.push({
      name: 'TRIGGER_MODE',
      message: `значение не распознано — будет использовано «${TRIGGER_MODES[0]}». Допустимо: ${TRIGGER_MODES.join(', ')}`
    })
  }
  addRangeNotice(warnings, {
    name: 'STAGE_ENTRY_WINDOW_SECONDS',
    raw: val('STAGE_ENTRY_WINDOW_SECONDS'),
    min: STAGE_ENTRY_WINDOW_MIN_SEC,
    max: STAGE_ENTRY_WINDOW_MAX_SEC,
    unit: 'секунд'
  })
  addRangeNotice(warnings, {
    name: 'TOKEN_KEEPALIVE_HOURS',
    raw: val('TOKEN_KEEPALIVE_HOURS'),
    min: MIN_KEEPALIVE_HOURS,
    max: MAX_KEEPALIVE_HOURS,
    fallback: DEFAULT_KEEPALIVE_HOURS,
    unit: 'часов'
  })

  // Уровень логов читается как LOG_LEVEL ?? NUXT_LOG_LEVEL — проверяем обе, иначе при опечатке в
  // приоритетной переменной часть этого же отчёта могла бы не дойти до лога.
  for (const name of ['LOG_LEVEL', 'NUXT_LOG_LEVEL']) {
    // ⚠️ Сравниваем СЫРОЕ значение: `isLogLevel` регистрозависим и не тримит, поэтому `WARN` или
    // ` warn` молча откатываются на info. Лоуэркейсить здесь — значит промолчать ровно там, где
    // человек уверен, что включил нужный уровень.
    const level = env[name] ?? ''
    if (level && !(LOG_LEVELS as readonly string[]).includes(level)) {
      warnings.push({
        name,
        message: `значение не распознано — будет использовано «info». Допустимо (строчными, без пробелов): ${LOG_LEVELS.join(', ')}`
      })
    }
  }

  // ── Заголовки безопасности ───────────────────────────────────────────────────────────────
  const csp = val('CSP_MODE').toLowerCase()
  if (csp && !(CSP_MODES as readonly string[]).includes(csp)) {
    warnings.push({
      name: 'CSP_MODE',
      message: `значение не распознано — будет использовано «enforce». Допустимо: ${CSP_MODES.join(', ')}`
    })
  } else if (csp && csp !== 'enforce' && prod) {
    warnings.push({
      name: 'CSP_MODE',
      message: 'в production выбран режим отчёта или отключения — защита ослаблена. Это временная мера для диагностики, верните enforce'
    })
  }
  // Непригодные источники отбрасываются молча (`sanitizeFrameAncestors`), а последствие видно только в
  // консоли браузера: приложение во фрейме показывает пустоту при 200 в логах.
  const extraAncestors = val('CSP_FRAME_ANCESTORS')
  if (extraAncestors) {
    const items = extraAncestors.split(/[\s,]+/).filter((s) => s.length > 0)
    const bad = items.filter((s) => !/^https:\/\/(\*\.)?[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+(:\d{1,5})?$/i.test(s))
    if (bad.length > 0) {
      warnings.push({
        name: 'CSP_FRAME_ANCESTORS',
        message: `${bad.length} из ${items.length} записей отброшено (нужен вид https://портал.зона или https://*.зона) — эти порталы не смогут открыть приложение во фрейме`
      })
    }
  }

  // ── Канал отзывов ────────────────────────────────────────────────────────────────────────
  const fbToken = val('GITHUB_FEEDBACK_TOKEN')
  const fbRepo = val('GITHUB_FEEDBACK_REPO')
  if (!!fbToken !== !!fbRepo) {
    warnings.push({
      name: fbToken ? 'GITHUB_FEEDBACK_REPO' : 'GITHUB_FEEDBACK_TOKEN',
      message: 'задана только половина пары — канал отзывов выключен, кнопки 👍/👎 показываться не будут. Задайте обе переменные'
    })
  } else if (fbRepo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fbRepo)) {
    warnings.push({
      name: 'GITHUB_FEEDBACK_REPO',
      message: 'нужен вид «владелец/репозиторий» — сейчас канал отзывов выключен, кнопки 👍/👎 показываться не будут'
    })
  } else if (fbRepo && isPlaceholder(fbRepo)) {
    warnings.push({
      name: 'GITHUB_FEEDBACK_REPO',
      message: 'осталось значение-заглушка из примера — канал отзывов работать не будет. Укажите свой приватный репозиторий'
    })
  }

  addRangeNotice(warnings, {
    name: 'TOMBSTONE_TTL_DAYS',
    raw: val('TOMBSTONE_TTL_DAYS'),
    min: MIN_TOMBSTONE_DAYS,
    max: MAX_TOMBSTONE_DAYS,
    fallback: DEFAULT_TOMBSTONE_DAYS,
    unit: 'суток'
  })

  // ── Анти-абьюз за прокси ─────────────────────────────────────────────────────────────────
  // Молчаливая деградация: без этой переменной за обратным прокси адрес сокета одинаков у ВСЕХ, и
  // лимиты по IP превращаются в один общий счётчик на сервис. Ошибка не видна ни в логе, ни в
  // ответах — поэтому про неё говорим при старте.
  //
  // Три случая РАЗНЫЕ, и путать их нельзя:
  //  — не задано в проде: скорее всего забыли (но прокси может и не быть) → говорим в боевом режиме;
  //  — явный `0`: осознанный выбор «прокси нет», это документированное значение → молчим;
  //  — мусор либо больше максимума: значение выглядит заданным, а доверия не даёт → говорим ВСЕГДА,
  //    в том числе локально, иначе опечатку заметят только в бою.
  const trustedRaw = val('TRUSTED_PROXIES')
  if (!trustedRaw) {
    if (prod) {
      warnings.push({
        name: 'TRUSTED_PROXIES',
        message: 'не задан — если приложение стоит за обратным прокси (типичный прод), лимиты по IP считаются по адресу прокси, то есть одним счётчиком на всех. За одним nginx задайте 1. В нашем docker-compose.prod.yml значение уже подставляется по умолчанию'
      })
    }
  } else if (trustedRaw !== '0' && resolveTrustedProxies(trustedRaw) === 0) {
    warnings.push({
      name: 'TRUSTED_PROXIES',
      message: `значение не принято — нужно целое от 1 до ${MAX_TRUSTED_PROXIES}. Заголовок X-Forwarded-For игнорируется, лимиты считаются по адресу сокета. Завышенное число намеренно не «поправляется» к границе: лишний хоп увёл бы ключ лимитера в ту часть заголовка, которую пишет отправитель запроса`
    })
  }

  // ── Режим запуска ────────────────────────────────────────────────────────────────────────
  // Строгость проверок висит на NODE_ENV, и он же открывает дашборд в не-проде. Запуск боевого
  // окружения мимо нашего образа (там NODE_ENV выставлен) даёт худшую комбинацию: дашборд открыт,
  // а проверка молчит про всё сразу. Ловим по позитивному признаку «окружение выглядит боевым».
  if (!prod && (db || hasId || domain)) {
    warnings.push({
      name: 'NODE_ENV',
      message: 'не равен production, хотя окружение выглядит боевым (заданы база / OAuth-креды / домен). В этом режиме дашборд открыт без авторизации, а часть проверок не выполняется'
    })
  }

  // ── Телеметрия ───────────────────────────────────────────────────────────────────────────
  // Признак включённости спрашиваем у того же кода, что решает в бою (`telemetryEnabled`), а не
  // повторяем условие здесь: иначе предполётная проверка однажды соврёт про включённость.
  // Адрес коллектора — единственный рычаг, отдельного флага нет. Проверяем ФОРМУ, а не доступность:
  // недоступный коллектор телеметрию просто не даёт, а вот опечатка в схеме тихо не даст её никогда.
  if (telemetryEnabled(env)) {
    const endpoint = val('OTEL_EXPORTER_OTLP_ENDPOINT')
    if (!/^https?:\/\//i.test(endpoint)) {
      warnings.push({
        name: 'OTEL_EXPORTER_OTLP_ENDPOINT',
        message: 'задан, но не похож на адрес (ожидается http:// или https://) — трейсы уходить не будут'
      })
    }
  }

  return { errors, warnings }
}

/**
 * Замечание о числовой переменной. Два случая РАЗНЫЕ, и путать их нельзя: нечисловое значение падает
 * на умолчание, а число вне диапазона **прижимается к границе**. Именно две самые вероятные опечатки
 * (лишний ноль, дробь) дают второй случай, и сказать про них «используется 24» было бы неправдой.
 */
function addRangeNotice(
  out: EnvIssue[],
  o: { name: string; raw: string; min: number; max: number; fallback?: number; unit: string }
): void {
  if (!o.raw) return
  const n = Number(o.raw)
  if (!Number.isFinite(n)) {
    out.push({
      name: o.name,
      message: `значение не число — будет использовано умолчание${o.fallback ? ` (${o.fallback} ${o.unit})` : ''}`
    })
    return
  }
  if (n < o.min) {
    out.push({ name: o.name, message: `значение меньше допустимого — будет использовано ${o.min} ${o.unit}` })
  } else if (n > o.max) {
    out.push({ name: o.name, message: `значение больше допустимого — будет использовано ${o.max} ${o.unit}` })
  }
}

/** Есть ли о чём говорить: пустой отчёт логировать не нужно. */
export function hasEnvIssues(report: EnvReport): boolean {
  return report.errors.length > 0 || report.warnings.length > 0
}
