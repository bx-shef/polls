/**
 * Бутстрап OpenTelemetry. Грузится через `NODE_OPTIONS=--import ./otel.instrument.mjs` — то есть
 * ДО приложения, и это не стилистика: авто-инструментирование подменяет `require`/`import` библиотек
 * (`http`, `pg`, `undici`), а подменить их можно только до того, как их загрузит кто-то другой.
 * Импортированный после приложения бутстрап зарегистрируется и не перехватит ничего — молча.
 *
 * **Без `OTEL_EXPORTER_OTLP_ENDPOINT` файл не делает НИЧЕГО** и выходит на первой строке. Это
 * заявленное состояние по умолчанию: адрес коллектора — единственный рычаг.
 *
 * ⚠️ Этот файл — обычный `.mjs`, он грузится раньше сборки и наш TypeScript импортировать не может.
 * Поэтому список безопасных атрибутов здесь **продублирован** из `src/obs/redact-span.ts`, и
 * расхождение ловит тест `test/redact-span.test.ts` (он читает этот файл и сверяет списки). Дубль
 * осознанный: альтернатива — собирать бутстрап отдельным шагом сборки ради одного массива строк.
 */

/**
 * ⚠️ Списки, процессор и сборка конвейера объявлены на ВЕРХНЕМ уровне и экспортируются — ради
 * исполняемого теста. Раньше они лежали внутри `start()`, и проверить их можно было только грепом по
 * исходнику: ни выпавший из `spanProcessors` процессор, ни пустой `onEnd` греп не ловит. В этом
 * проекте такой подход уже дважды провалился (#153, #159), поэтому здесь он не повторяется.
 * Импорты самого SDK остаются ВНУТРИ `start()`: без адреса коллектора мы не должны ни грузить их, ни
 * платить временем старта — модулей может не быть в образе вовсе.
 */

// ⚠️ ДУБЛЬ `SAFE_FOREIGN_ATTRIBUTES` из src/obs/redact-span.ts — сверяется тестом.
export const SAFE_FOREIGN_ATTRIBUTES = [
  'http.request.method',
  'http.method',
  'http.response.status_code',
  'http.status_code',
  'url.scheme',
  'http.route',
  'db.system',
  'db.operation',
  'messaging.system'
]
// ⚠️ ДУБЛЬ `OWN_ATTRIBUTE_PREFIXES` из src/obs/redact-span.ts — сверяется тестом.
export const OWN_ATTRIBUTE_PREFIXES = ['portal.', 'b24.', 'error_kind', 'stage']

const allowed = new Set(SAFE_FOREIGN_ATTRIBUTES)
const isOwn = (key) =>
  OWN_ATTRIBUTE_PREFIXES.some((p) => (p.endsWith('.') ? key.startsWith(p) : key === p))

/**
 * Останется ли атрибут в спане. Экспортируется, чтобы тест проверял РЕШЕНИЕ, а не литерал массива:
 * сверка списков обходится и комментарием-обманкой с таким же объявлением выше настоящего, и
 * расширением прямо на месте использования (`new Set([...SAFE_FOREIGN_ATTRIBUTES, 'db.statement'])`).
 * Оба обхода показало ревью, и оба оставляли тесты зелёными.
 */
export const isAttributeKept = (key) => allowed.has(key) || isOwn(key)

/**
 * Процессор вычистки. Стоит ПЕРЕД экспортирующим: `MultiSpanProcessor` вызывает `onEnd` по порядку,
 * и спан, дошедший до экспортёра нередактированным, уже не вернуть.
 *
 * Правит спан НА МЕСТЕ, потому что интерфейс процессора не даёт вернуть новый объект. Отсюда же
 * `try/catch` вокруг всего: сбой вычистки не должен ни ронять процесс, ни — что важнее — выпустить
 * спан наружу полузачищенным.
 */
export class RedactingSpanProcessor {
  onStart() {}

  onEnd(span) {
    try {
      const attrs = span.attributes ?? {}
      for (const key of Object.keys(attrs)) {
        if (!allowed.has(key) && !isOwn(key)) delete attrs[key]
      }
      // События несут `exception.message` и `exception.stacktrace` — тот же свободный текст, из-за
      // которого у себя мы запретили `recordException`. Наш запрет покрывает НАШ код, не чужой.
      if (Array.isArray(span.events) && span.events.length) span.events.length = 0
      // Сообщение статуса — ещё одно поле для свободной строки.
      if (span.status && typeof span.status === 'object' && span.status.message) {
        delete span.status.message
      }
    } catch {
      // Вычистка сломалась на полпути — спан НЕ выпускаем полузачищенным. Пустой спан плох для
      // диагностики; нередактированный плох для людей, чьи данные в нём лежат.
      try {
        const attrs = span.attributes ?? {}
        for (const key of Object.keys(attrs)) delete attrs[key]
        if (Array.isArray(span.events)) span.events.length = 0
        if (span.status && typeof span.status === 'object') delete span.status.message
      } catch { /* уже ничего не поделать */ }
    }
  }

  shutdown() { return Promise.resolve() }
  forceFlush() { return Promise.resolve() }
}

/**
 * Конфиг `NodeSDK` — чистая функция от инъектированных конструкторов SDK. Вынесена ровно затем, чтобы
 * тест мог ИСПОЛНИТЬ сборку конвейера на фейках, не устанавливая сам SDK, и проверить ПОРЯДОК
 * процессоров, а не упоминание процессора в исходнике.
 */
export function buildSdkConfig(deps, endpoint) {
  const { resourceFromAttributes, BatchSpanProcessor, OTLPTraceExporter } = deps
  return {
    resource: resourceFromAttributes({
      'service.name': process.env.OTEL_SERVICE_NAME ?? 'polls'
    }),
    // ⚠️ Детекторы РЕСУРСА отключены явно. По умолчанию `NodeSDK` включает host/process-детекторы, и в
    // каждый спан уезжают `host.name`, `process.owner`, `process.command_args` (а там бывает строка
    // подключения) — то есть топология нашей инфраструктуры в общий приёмник. Ревью показало это на
    // перехваченном OTLP-трафике; до правки JSDoc и карта утверждали, что вычистка есть, а её не было.
    resourceDetectors: [],
    spanProcessors: [
      new RedactingSpanProcessor(),
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }))
    ],
    // ⚠️ Авто-инструментирование НЕ подключено, и это осознанно, а не забыто. Точка входа рантайма —
    // `.output/server/index.mjs`, то есть ESM: патчить модули без хука `import-in-the-middle` OTel не
    // умеет (проверено ревью — при ESM-загрузке `http` спанов ноль, при CJS три). А `pg` Nitro
    // вбандливает в `.output`, и подменить его нельзя в принципе. Итог был бы 80 МБ зависимостей,
    // в 6,7 раза тяжелее самого приложения, ради нулевого выхлопа.
    // Экспортируются НАШИ спаны (`withSpan`/`withDependencySpan`) — они на `@opentelemetry/api` и от
    // системы модулей не зависят. Вычистка чужих атрибутов остаётся на месте: она понадобится в тот
    // же день, когда авто-инструментирование включат, и ставить её задним числом поздно.
    instrumentations: []
  }
}

const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').trim()
if (endpoint) {
  // ⚠️ FAIL-OPEN, и это не перестраховка. Бутстрап грузится через `--import`, то есть ДО приложения:
  // любой брошенный отсюда сбой убивает процесс раньше, чем стартует сервис, и падает он в preload —
  // до нашего логгера, поэтому в журнале будет только чужой стектрейс. Проверено ревью на раскладке
  // образа: без этого включение телеметрии переменной окружения превращалось в выключение СЕРВИСА,
  // причём без PR, без CI и без ревью. Телеметрия не имеет права ронять то, что наблюдает, — это тот
  // же инвариант, что и в `withSpan`, только ценой ошибки здесь — весь процесс.
  try {
    await start()
  } catch (e) {
    // Единственная строка, которую мы можем себе позволить: логгер приложения ещё не существует.
    console.error('[otel] бутстрап не поднялся, сервис продолжает работу без телеметрии:', e?.message ?? e)
  }
}

async function start() {
  const { NodeSDK } = await import('@opentelemetry/sdk-node')
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http')
  const { BatchSpanProcessor } = await import('@opentelemetry/sdk-trace-base')
  const { resourceFromAttributes } = await import('@opentelemetry/resources')

  const sdk = new NodeSDK(buildSdkConfig(
    { resourceFromAttributes, BatchSpanProcessor, OTLPTraceExporter },
    endpoint
  ))

  sdk.start()

  // Аккуратное завершение: недоотправленные спаны при остановке контейнера теряются молча.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => { void sdk.shutdown().catch(() => {}) })
  }
}
