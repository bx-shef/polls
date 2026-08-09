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

const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').trim()
if (endpoint) {
  await start()
}

async function start() {
  // Импорты — ВНУТРИ ветки: без адреса коллектора мы не должны ни грузить SDK, ни платить за него
  // временем старта. Модули тяжёлые, и в образе их может не быть вовсе.
  const { NodeSDK } = await import('@opentelemetry/sdk-node')
  const { getNodeAutoInstrumentations } = await import('@opentelemetry/auto-instrumentations-node')
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http')
  const { BatchSpanProcessor } = await import('@opentelemetry/sdk-trace-base')
  const { resourceFromAttributes } = await import('@opentelemetry/resources')

  // ⚠️ ДУБЛЬ `SAFE_FOREIGN_ATTRIBUTES` из src/obs/redact-span.ts — сверяется тестом.
  const SAFE_FOREIGN_ATTRIBUTES = [
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
  const OWN_ATTRIBUTE_PREFIXES = ['portal.', 'b24.', 'error_kind', 'stage']

  const allowed = new Set(SAFE_FOREIGN_ATTRIBUTES)
  const isOwn = (key) =>
    OWN_ATTRIBUTE_PREFIXES.some((p) => (p.endsWith('.') ? key.startsWith(p) : key === p))

  /**
   * Процессор вычистки. Стоит ПЕРЕД экспортирующим: `MultiSpanProcessor` вызывает `onEnd` по порядку,
   * и спан, дошедший до экспортёра нередактированным, уже не вернуть.
   *
   * Правит спан НА МЕСТЕ, потому что интерфейс процессора не даёт вернуть новый объект. Отсюда же
   * `try/catch` вокруг всего: сбой вычистки не должен ни ронять процесс, ни — что важнее —
   * пропустить спан дальше нетронутым.
   */
  class RedactingSpanProcessor {
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
        // Вычистка сломалась — спан не выпускаем. Пустые атрибуты хуже, чем нередактированные,
        // только для диагностики; наоборот — хуже для людей, чьи данные в них лежат.
        try {
          for (const key of Object.keys(span.attributes ?? {})) delete span.attributes[key]
          if (Array.isArray(span.events)) span.events.length = 0
        } catch { /* уже ничего не поделать */ }
      }
    }

    shutdown() { return Promise.resolve() }
    forceFlush() { return Promise.resolve() }
  }

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      'service.name': process.env.OTEL_SERVICE_NAME ?? 'polls'
    }),
    spanProcessors: [
      new RedactingSpanProcessor(),
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }))
    ],
    instrumentations: [
      getNodeAutoInstrumentations({
        // ⚠️ Файловые операции засыпают трейс шумом и несут пути — выключаем.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        // ⚠️ Параметры запроса к БД — это значения полей, то есть тексты ответов. Никогда.
        '@opentelemetry/instrumentation-pg': { enhancedDatabaseReporting: false }
      })
    ]
  })

  sdk.start()

  // Аккуратное завершение: недоотправленные спаны при остановке контейнера теряются молча.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => { void sdk.shutdown().catch(() => {}) })
  }
}
