/**
 * Проверка окружения при старте.
 *
 * **Зачем.** Половина строк таблицы «Если что-то пошло не так» (карта проекта) — это неверная
 * переменная окружения. Сегодня такая ошибка обнаруживается уже в бою и выглядит непонятно: дашборд
 * молча отдаёт 503, установка молча отдаёт 503, данные молча исчезают после перезапуска. Человек видит
 * симптом, а не причину. Впереди первый живой прогон на портале — и там цена такой отладки самая
 * высокая: приложение уже стоит на чужом портале, а понять, что не так, неоткуда.
 *
 * Здесь мы превращаем эти симптомы в понятные сообщения ОДИН раз при запуске, до первого запроса.
 *
 * **Не роняем процесс.** Часть переменных фатальна и без нас (ключ шифрования проверяет свой загрузчик),
 * а остальное — это выбор режима: без `DATABASE_URL` приложение осознанно работает на памяти, без
 * OAuth-кред — без связки с порталом. Наша задача — назвать последствия вслух, а не решать за владельца.
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

/** 64 hex-символа = 32 байта ключа AES-256. */
const HEX64 = /^[0-9a-f]{64}$/i

/**
 * Проверить окружение. Чистая функция: окружение передаётся аргументом, наружу — только отчёт.
 * Поэтому проверяется юнит-тестами без подмены `process.env`.
 */
export function checkEnv(env: Record<string, string | undefined>, opts: EnvCheckOptions = {}): EnvReport {
  const errors: EnvIssue[] = []
  const warnings: EnvIssue[] = []
  const prod = opts.isProduction === true
  const val = (n: string): string => (env[n] ?? '').trim()

  // ── Дашборд (контур B) ───────────────────────────────────────────────────────────────────
  const secret = val('DASHBOARD_AUTH_SECRET')
  if (!secret) {
    if (prod) {
      errors.push({
        name: 'DASHBOARD_AUTH_SECRET',
        message: 'не задан — дашборд будет отдавать 503, а вход из Bitrix24 не заработает. Задайте ≥32 символов: openssl rand -hex 32'
      })
    }
  } else if (isPlaceholder(secret)) {
    errors.push({ name: 'DASHBOARD_AUTH_SECRET', message: 'осталось значение-заглушка из примера — замените на настоящий секрет' })
  } else if (secret.length < 32) {
    errors.push({
      name: 'DASHBOARD_AUTH_SECRET',
      message: `слишком короткий (${secret.length} символов, нужно ≥32) — дашборд будет отдавать 503`
    })
  }

  if (val('DASHBOARD_DEV_OPEN') && prod) {
    errors.push({
      name: 'DASHBOARD_DEV_OPEN',
      message: 'включён в production — дашборд открыт БЕЗ авторизации, наружу уйдут имена клиентов и ответственных. Уберите переменную'
    })
  }

  // ── Хранилище ────────────────────────────────────────────────────────────────────────────
  if (!val('DATABASE_URL')) {
    const message =
      'не задан — приложение работает на временном хранилище в памяти: все ответы исчезнут при перезапуске, а вход из Bitrix24 будет всегда отдавать 401'
    if (prod) errors.push({ name: 'DATABASE_URL', message })
    else warnings.push({ name: 'DATABASE_URL', message })
  }

  // ── Связка с Bitrix24 ────────────────────────────────────────────────────────────────────
  const tokenKey = val('NUXT_BITRIX_TOKEN_KEY')
  if (!tokenKey) {
    warnings.push({
      name: 'NUXT_BITRIX_TOKEN_KEY',
      message: 'не задан — установку на портал принять не получится (нечем шифровать токены). Задайте 64 hex: openssl rand -hex 32'
    })
  } else if (isPlaceholder(tokenKey)) {
    errors.push({ name: 'NUXT_BITRIX_TOKEN_KEY', message: 'осталось значение-заглушка из примера — замените на настоящий ключ' })
  } else if (!HEX64.test(tokenKey)) {
    errors.push({
      name: 'NUXT_BITRIX_TOKEN_KEY',
      message: `должен быть ровно 64 hex-символа (сейчас ${tokenKey.length}) — приложение не примет установку`
    })
  }

  const hasId = !!val('NUXT_B24_CLIENT_ID')
  const hasSecret = !!val('NUXT_B24_CLIENT_SECRET')
  if (hasId !== hasSecret) {
    errors.push({
      name: hasId ? 'NUXT_B24_CLIENT_SECRET' : 'NUXT_B24_CLIENT_ID',
      message: 'задана только половина пары OAuth-кред — связка с порталом не заработает'
    })
  } else if (!hasId) {
    warnings.push({
      name: 'NUXT_B24_CLIENT_ID / NUXT_B24_CLIENT_SECRET',
      message: 'не заданы — установка на портал и фоновое обновление токенов работать не будут'
    })
  }

  if (!val('APP_DOMAIN') && !val('DOMAIN')) {
    warnings.push({
      name: 'APP_DOMAIN / DOMAIN',
      message: 'не задан домен приложения — ссылки-приглашения и адреса встроек соберутся неверно'
    })
  } else if (isPlaceholder(val('DOMAIN'))) {
    warnings.push({ name: 'DOMAIN', message: 'осталось значение-заглушка из примера' })
  }

  // ── Поведение (мусор здесь молча падает на значение по умолчанию — предупреждаем) ─────────
  const mode = val('TRIGGER_MODE').toLowerCase()
  if (mode && !['event', 'robot', 'both'].includes(mode)) {
    warnings.push({
      name: 'TRIGGER_MODE',
      message: 'значение не распознано — используется event. Допустимо: event, robot, both'
    })
  }
  const window = val('STAGE_ENTRY_WINDOW_SECONDS')
  if (window && !(Number(window) >= 5 && Number(window) <= 3600)) {
    warnings.push({
      name: 'STAGE_ENTRY_WINDOW_SECONDS',
      message: 'значение вне диапазона 5–3600 — будет прижато к границе или заменено на 60'
    })
  }
  const keepalive = val('TOKEN_KEEPALIVE_HOURS')
  if (keepalive && !(Number(keepalive) >= 1 && Number(keepalive) <= 168)) {
    warnings.push({ name: 'TOKEN_KEEPALIVE_HOURS', message: 'значение вне диапазона 1–168 — используется 24' })
  }
  const level = val('NUXT_LOG_LEVEL').toLowerCase()
  if (level && !['debug', 'info', 'warn', 'error'].includes(level)) {
    warnings.push({
      name: 'NUXT_LOG_LEVEL',
      message: 'значение не распознано — используется info. Допустимо: debug, info, warn, error'
    })
  }
  const csp = val('CSP_MODE').toLowerCase()
  if (csp && !['enforce', 'report', 'off'].includes(csp)) {
    warnings.push({ name: 'CSP_MODE', message: 'значение не распознано — используется enforce. Допустимо: enforce, report, off' })
  } else if (csp && csp !== 'enforce' && prod) {
    warnings.push({
      name: 'CSP_MODE',
      message: `в production выбран режим «${csp}» — защита от кликджекинга ослаблена. Это временная мера, не забудьте вернуть enforce`
    })
  }

  // ── Канал отзывов ────────────────────────────────────────────────────────────────────────
  const fbToken = val('GITHUB_FEEDBACK_TOKEN')
  const fbRepo = val('GITHUB_FEEDBACK_REPO')
  if (!!fbToken !== !!fbRepo) {
    warnings.push({
      name: fbToken ? 'GITHUB_FEEDBACK_REPO' : 'GITHUB_FEEDBACK_TOKEN',
      message: 'задана только половина пары — канал отзывов выключен, кнопки 👍/👎 показываться не будут'
    })
  } else if (fbRepo && isPlaceholder(fbRepo)) {
    warnings.push({ name: 'GITHUB_FEEDBACK_REPO', message: 'осталось значение-заглушка из примера — канал отзывов работать не будет' })
  }

  return { errors, warnings }
}

/** Есть ли о чём говорить: пустой отчёт логировать не нужно. */
export function hasEnvIssues(report: EnvReport): boolean {
  return report.errors.length > 0 || report.warnings.length > 0
}
