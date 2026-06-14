/**
 * Наблюдаемость (#5): минимальный framework-agnostic интерфейс структурного
 * логирования + zero-dep JSON-реализация с редакцией секретов.
 *
 * Почему не Pino/Sentry прямо в ядре: конвенция репо — «только zod в prod».
 * Слой деплоя (Nuxt/Nitro) уже тащит свой логгер (consola/pino) и Sentry SDK —
 * ядро не пинит их версии и остаётся портируемым. Прод подменяет `Logger`
 * адаптером ровно так же, как OAuth берёт `fetch`, `PgStore` — драйвер БД, а
 * хендлеры — часы. Дефолт `createJsonLogger` достаточен для node-адаптера и `serve`.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

/** Структурные поля записи (произвольный JSON; секретные ключи редактируются). */
export type LogFields = Record<string, unknown>

/**
 * Контракт логгера. Сигнатура «сообщение + структурные поля» (а не printf) —
 * чтобы запись машинно-разбираемой строкой JSON, а не склейкой текста.
 */
export interface Logger {
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
  /** Дочерний логгер с примешанными полями (request-scoped контекст). */
  child(bindings: LogFields): Logger
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/**
 * Подстроки секретных ключей (lowercase). Сопоставление по `includes` —
 * `accessToken`/`refresh_token`/`portalTokens` и т.п. ловятся одной подстрокой
 * `token`. Список НАМЕРЕННО узкий: «key» не включён, иначе под нож попали бы
 * доменные `surveyKey`/`questionKey`/`optionKey` (это идентификаторы, не секреты).
 */
const SECRET_KEY_PARTS = [
  'token', // access_token, refresh_token, portal.tokens, tokenKey (ключ шифратора)
  'secret', // client_secret
  'password',
  'passwd',
  'authorization',
  'cookie',
  'nonce', // одноразовый анти-абьюз-токен (replay в пределах TTL)
  'credential',
  'apikey',
  'api_key',
  'privatekey',
  'private_key'
] as const

const REDACTED = '[REDACTED]'
const MAX_DEPTH = 8
const MAX_STRING = 10_000

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase()
  return SECRET_KEY_PARTS.some((p) => k.includes(p))
}

/**
 * Глубокое маскирование: значения секретных ключей → `[REDACTED]`, защита от
 * циклов (`[Circular]`), глубины (`[Truncated]`) и гигантских строк. Редакция
 * по ИМЕНИ ключа (а не сканированием значений) — детерминированно и без ложных
 * срабатываний; следствие: не кладите секреты в сообщения ошибок/строки
 * подключения (их значение под ключом `message`/`stack` не маскируется).
 * Возвращает НОВУЮ структуру — исходные поля вызывающего не мутируются.
 */
export function redact(value: unknown): unknown {
  return redactInner(value, 0, new WeakSet<object>())
}

function redactInner(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return '[Truncated]'
  if (ancestors.has(value)) return '[Circular]'
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map((v) => redactInner(v, depth + 1, ancestors))
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? REDACTED : redactInner(v, depth + 1, ancestors)
    }
    return out
  } finally {
    // Снимаем со «стека предков» при разворачивании — DAG (общая ссылка вне
    // текущего пути) не помечается как цикл, помечаются только настоящие циклы.
    ancestors.delete(value)
  }
}

/** Нормализует unknown-ошибку в логируемые поля (для onError/process-хуков). */
export function errInfo(e: unknown): LogFields {
  if (e instanceof Error) return { name: e.name, message: e.message, stack: e.stack }
  return { message: String(e) }
}

export interface JsonLoggerOptions {
  /** Минимальный уровень; ниже — молчим. Default: env LOG_LEVEL/NUXT_LOG_LEVEL → 'info'. */
  level?: LogLevel
  /** Куда писать строку. Default: stdout для debug/info, stderr для warn/error. */
  sink?: (level: LogLevel, line: string) => void
  /** Часы (тесты фиксируют время). */
  now?: () => Date
  /** Базовые поля в каждой записи (напр. `{ svc: 'polls' }`). */
  base?: LogFields
}

function defaultSink(level: LogLevel, line: string): void {
  // warn/error → stderr (отделяется от потока данных в pipeline'ах оператора).
  if (level === 'warn' || level === 'error') console.error(line)
  else console.log(line)
}

function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === 'string' && (LOG_LEVELS as readonly string[]).includes(v)
}

function resolveEnvLevel(): LogLevel {
  const env = typeof process !== 'undefined' ? process.env : undefined
  const raw = env?.['LOG_LEVEL'] ?? env?.['NUXT_LOG_LEVEL']
  return isLogLevel(raw) ? raw : 'info'
}

/**
 * Zero-dep структурный логгер: одна строка JSON на запись
 * (`{ level, time, msg, ...поля }`), секреты редактируются. Уровень и `time`/
 * `msg` зарезервированы и не перетираются полями. `child()` примешивает поля.
 */
export function createJsonLogger(opts: JsonLoggerOptions = {}): Logger {
  const min = opts.level ?? resolveEnvLevel()
  const now = opts.now ?? ((): Date => new Date())
  const sink = opts.sink ?? defaultSink
  return build(min, now, sink, opts.base ?? {})
}

function build(min: LogLevel, now: () => Date, sink: (l: LogLevel, line: string) => void, base: LogFields): Logger {
  const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (RANK[level] < RANK[min]) return
    const safe = redact({ ...base, ...fields }) as LogFields
    // Зарезервированные поля идут ПОСЛЕ spread — их нельзя перетереть из fields.
    sink(level, JSON.stringify({ ...safe, level, time: now().toISOString(), msg }))
  }
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (bindings) => build(min, now, sink, { ...base, ...bindings })
  }
}

/** Логгер-заглушка (default для библиотек/тестов — тишина без сайд-эффектов). */
export const nullLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => nullLogger
}
