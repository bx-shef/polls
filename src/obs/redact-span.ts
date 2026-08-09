/**
 * Вычистка атрибутов, которые проставляет НЕ наш код.
 *
 * **Почему этого не делает белый список из `telemetry.ts`.** Тот список управляет тем, что кладём МЫ.
 * Но как только SDK зарегистрирован, спаны начинает создавать авто-инструментирование чужих библиотек
 * (`http`, `pg`, `undici`), и оно наполняет их по своим правилам, ни о каком нашем списке не зная.
 * Именно там и лежит то, ради чего перенос телеметрии разбит на два шага.
 *
 * Что приезжает без этой вычистки — разобрано на нашем коде, а не взято из общих соображений:
 *
 *  - **`db.statement`** — текст SQL. Пока каждый запрос параметризован, литералов в нём нет; но любой
 *    запрос со склейкой — и в трейсе оказывается текст ответа респондента. Полагаться на то, что
 *    склейки не появится, — это снова «правило, которое надо помнить».
 *  - **`url.path` / `http.target`** — у нас в путях лежат **токены доступа**: `/s/:key` открывает
 *    прохождение опроса, `/d/:key` — дашборд. Это не идентификаторы, это ключи.
 *  - **`client.address` / `net.peer.ip`** — адрес респондента. Самое неприятное во всём списке: адрес
 *    вместе с меткой времени серверного спана джойнится с анонимной строкой ответа и **ломает порог
 *    анонимности 5**. Обход `meetsAnonymity` получается не через агрегаты, которые мы защищали, а
 *    через трейсы, о которых защита ничего не знает.
 *  - **`url.full` / `server.address` / `net.peer.name`** — домен портала (имя заказчика), а в query
 *    исходящих вызовов к Bitrix ещё и `auth=<токен>`. Свой спан мы аккуратно этого лишили —
 *    авто-инструментирование положит рядом.
 *  - **`exception.message` / `exception.stacktrace`** в событиях спана — тот же свободный текст, из-за
 *    которого у себя мы запретили `recordException`. Наш запрет покрывает НАШ код, не чужой.
 *  - **`user_agent.original`**, `db.user`, `db.name`, `host.name`, `process.command_args`,
 *    `process.owner` — по мелочи, но всё это либо про человека, либо про нашу инфраструктуру.
 *
 * **Поэтому политика та же, что и у своих атрибутов: пропустить известное, а не выбросить плохое.**
 * Список «выбросить» устаревает молча — семантические соглашения OTel переименовывают атрибуты между
 * версиями (`http.url` → `url.full`, `net.peer.ip` → `client.address`), и обновление инструментации
 * тихо открывает то, что вчера было закрыто. Список «пропустить» при переименовании теряет атрибут —
 * это заметно и безопасно.
 */

/**
 * Чужие атрибуты, которые разрешено оставить.
 *
 * Критерий тот же: «что именно окажется в значении и может ли это быть данными человека». Здесь
 * остались только глаголы, коды и имена систем — то, что не бывает содержимым.
 */
export const SAFE_FOREIGN_ATTRIBUTES = [
  // HTTP: метод и код ответа. Ни то, ни другое не несёт содержимого.
  'http.request.method',
  'http.method',
  'http.response.status_code',
  'http.status_code',
  // Схема (`https`) — но НЕ хост и НЕ путь.
  'url.scheme',
  // Шаблон маршрута (`/s/:key`), а НЕ заполненный путь: имя маршрута полезно, ключ в нём не заполнен.
  'http.route',
  // Какая это база («postgresql») — без адреса, пользователя и текста запроса.
  'db.system',
  'db.operation',
  // Имя очереди/системы обмена, если появится.
  'messaging.system'
] as const

export type SafeForeignAttribute = (typeof SAFE_FOREIGN_ATTRIBUTES)[number]

/**
 * Наши собственные атрибуты. Их уже проверил белый список `telemetry.ts` (имя И форма значения),
 * поэтому здесь они просто не выбрасываются.
 *
 * ⚠️ Список продублирован намеренно и сверяется тестом: этот модуль обязан оставаться самодостаточным,
 * потому что его копия живёт в бутстрапе SDK — обычном `.mjs`, который грузится ДО приложения и
 * импортировать наш TypeScript не может.
 */
export const OWN_ATTRIBUTE_PREFIXES = ['portal.', 'b24.', 'error_kind', 'stage'] as const

/** Значение атрибута спана в терминах OTel. */
export type SpanAttributeValue = string | number | boolean | Array<string | number | boolean | null | undefined> | undefined

/**
 * Оставить только безопасные атрибуты.
 *
 * Незнакомое имя выбрасывается молча — как и в `pickSafeAttributes`: телеметрия не имеет права ронять
 * обработку запроса, а отсутствие атрибута видно с первого взгляда на спан.
 */
export function redactSpanAttributes(
  attrs: Record<string, SpanAttributeValue>
): Record<string, SpanAttributeValue> {
  const allowed = new Set<string>(SAFE_FOREIGN_ATTRIBUTES)
  const out: Record<string, SpanAttributeValue> = {}
  for (const key of Object.keys(attrs)) {
    const value = attrs[key]
    if (value === undefined) continue
    if (allowed.has(key) || isOwnAttribute(key)) out[key] = value
  }
  return out
}

/** Наш ли это атрибут (по префиксу либо точному имени). */
export function isOwnAttribute(key: string): boolean {
  return OWN_ATTRIBUTE_PREFIXES.some((p) => (p.endsWith('.') ? key.startsWith(p) : key === p))
}

/**
 * Ресурсные атрибуты процесса, которые SDK проставляет автоматически.
 *
 * `service.name` оставляем — без него трейсы не с чем сопоставить. Всё, что описывает МАШИНУ и
 * ЗАПУСК (`host.name`, `process.command_args` — а там бывает строка подключения, `process.owner`),
 * убираем: приёмник общий, и разглашать топологию своей инфраструктуры ему незачем.
 */
export const SAFE_RESOURCE_ATTRIBUTES = ['service.name', 'service.version', 'deployment.environment'] as const

export function redactResourceAttributes(
  attrs: Record<string, SpanAttributeValue>
): Record<string, SpanAttributeValue> {
  const allowed = new Set<string>(SAFE_RESOURCE_ATTRIBUTES)
  const out: Record<string, SpanAttributeValue> = {}
  for (const key of Object.keys(attrs)) {
    const value = attrs[key]
    if (value !== undefined && allowed.has(key)) out[key] = value
  }
  return out
}

/**
 * Имена, ради которых всё это написано, — для тестов и для документации.
 *
 * Не используется в самой вычистке (она работает белым списком и не знает про «плохие» имена).
 * Держится здесь, чтобы тест мог утверждать не «незнакомое отбрасывается», а «вот именно ЭТО
 * отбрасывается» — на конкретных именах из реальных инструментаций.
 */
export const KNOWN_LEAKY_ATTRIBUTES = [
  'db.statement',
  'db.statement.parameters',
  'db.user',
  'db.name',
  'db.connection_string',
  'url.full',
  'url.path',
  'url.query',
  'http.url',
  'http.target',
  'server.address',
  'net.peer.name',
  'net.peer.ip',
  'client.address',
  'user_agent.original',
  'http.request.header.cookie',
  'http.request.header.authorization',
  'exception.message',
  'exception.stacktrace',
  'exception.type',
  'host.name',
  'process.command_args',
  'process.owner'
] as const
