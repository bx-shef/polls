/**
 * Телеметрия: что именно разрешено прикреплять к спану.
 *
 * **Зачем отдельный модуль, а не просто «добавим атрибуты к спану».** Трейсы уходят за пределы
 * приложения — в коллектор, в чужое хранилище, в чужой интерфейс. У нас в обороте данные, которых там
 * быть не должно ни при каких условиях: текст ответа клиента заказчика, имена и телефоны из снимка
 * сделки, токены портала. Обычная защита «не логируем секреты» здесь недостаточна, потому что она
 * работает **по имени ключа** (`redact`), а карта проекта прямо предупреждает: секрет, попавший в ТЕКСТ
 * ошибки, ею не маскируется.
 *
 * Поэтому защита устроена не как фильтр «выбросить плохое», а как **белый список «пропустить
 * известное»**: прикрепить к спану можно только атрибут, чьё имя перечислено здесь. Разница
 * принципиальная — при фильтре новое поле по умолчанию УТЕКАЕТ, и утечка появляется от невнимательности;
 * при белом списке новое поле по умолчанию не проходит, и чтобы его пропустить, нужно осознанно
 * дописать имя в этот файл. Текст ответа респондента прикрепить нельзя не потому, что кто-то помнил про
 * приватность, а потому, что для него здесь нет имени.
 *
 * Две производные из того же принципа:
 *  - **`portal.hash` вместо `member_id`.** Идентификатор портала — это заказчик; по нему трейсы
 *    связываются с конкретной компанией. Для разбора инцидента нужно лишь «это один и тот же портал или
 *    разные», а на это хватает хеша.
 *  - **`error_kind` вместо текста ошибки.** Текст — свободная строка из чужой библиотеки: в него уже
 *    попадали строка подключения к БД и адрес REST с токеном. Вид ошибки отвечает на вопрос «что
 *    сломалось» и не может унести с собой ничего лишнего.
 *
 * ⚠️ Этот модуль — половина защиты. Вторая половина — вычистка атрибутов, которые проставляет **не
 * наш** код: авто-инструментирование `pg` кладёт в спан текст SQL вместе с литералами, а это прямо
 * тексты ответов. Она живёт в бутстрапе SDK и должна приехать ВМЕСТЕ с ним (см. §Ключевые решения).
 * До появления SDK спаны — no-op, и утечь неоткуда.
 */

import { createHash } from 'node:crypto'
import { toSingleLine } from '../domain/text'

/**
 * Полный список имён атрибутов, которые нам разрешено прикреплять.
 *
 * Правило пополнения: имя добавляется только под ответ на вопрос «что именно окажется в значении и
 * может ли это быть данными человека». Если ответ «зависит» — не добавляем.
 */
export const TELEMETRY_ATTRIBUTES = [
  /** Хеш портала (НЕ member_id и НЕ домен) — связать спаны одного заказчика, не называя его. */
  'portal.hash',
  /** Имя метода REST Bitrix24 (`crm.deal.get`) — из нашего кода, не из данных. */
  'b24.method',
  /** Вид ошибки (НЕ текст) — см. {@link errorKind}. */
  'error_kind',
  /** Стадия исходящего вызова — закрытый набор {@link OUTGOING_STAGES}, не URL. */
  'stage'
] as const

// ⚠️ Список пополняется ТОЛЬКО вместе с местом вызова. Имя без места вызова — то же, от чего проект
// отказался в #31 («хелпер без места вызова — мёртвый код»): оно выглядит поддержанным, а на деле
// никем не проверено. Атрибуты исхода операции (`outcome`, `result.count`, `http.outcome`) требуют
// способа проставить значение ПОСЛЕ операции, которого у обёртки пока нет, — приезжают вместе с ним.

export type TelemetryAttributeName = (typeof TELEMETRY_ATTRIBUTES)[number]

/** Значение атрибута: только скаляры. Объект или массив — путь протащить структуру данных целиком. */
export type TelemetryValue = string | number | boolean

/** Кап длины значения: атрибут — метка, а не поле для содержимого. */
export const MAX_ATTRIBUTE_LENGTH = 64

/**
 * Правило для КАЖДОГО имени: что именно допустимо в значении.
 *
 * ⚠️ Это вторая половина белого списка, и без неё первая почти ничего не даёт. Ревью показало ровно
 * это: список фильтровал ИМЕНА, а значение под разрешённым именем проходило дословно — то есть
 * `{ stage: текстОтвета }` уезжал в трейс целиком, и все проверки оставались зелёными. Утверждение
 * «текст ответа прикрепить нельзя, для него нет имени» было неверным: имя находилось.
 *
 * Поэтому каждое имя объявляет форму значения, и она узкая: закрытый набор либо строгий шаблон.
 * Свободного текста в атрибутах не бывает вовсе — по замыслу, а не по договорённости.
 */
const ATTRIBUTE_RULES: Record<TelemetryAttributeName, (v: TelemetryValue) => boolean> = {
  // Хеш ровно той формы, что выдаёт portalHash: ни домен, ни member_id так не выглядят.
  'portal.hash': (v) => typeof v === 'string' && new RegExp(`^[0-9a-f]{${PORTAL_HASH_LENGTH}}$`).test(v),
  // Имя REST-метода Bitrix: буквы, цифры, точки. Данных человека такая форма не вмещает.
  'b24.method': (v) => typeof v === 'string' && /^[a-z][a-z0-9._]{0,63}$/i.test(v),
  // Закрытые наборы — сверяем принадлежность, а не форму.
  error_kind: (v) => typeof v === 'string' && (ERROR_KINDS as readonly string[]).includes(v),
  stage: (v) => typeof v === 'string' && (OUTGOING_STAGES as readonly string[]).includes(v)
}

/**
 * Отобрать разрешённые атрибуты.
 *
 * Незнакомое имя **молча отбрасывается**, и это осознанно: бросать исключение значило бы, что опечатка
 * в имени атрибута роняет обработку запроса — телеметрия начала бы влиять на работу сервиса, чего от
 * неё требуется не делать никогда. Отсутствие атрибута в трейсе заметно при первом же взгляде на спан,
 * а тест ниже держит сам список.
 */
export function pickSafeAttributes(
  input: Record<string, unknown>
): Partial<Record<TelemetryAttributeName, TelemetryValue>> {
  const out: Record<string, TelemetryValue> = {}
  for (const [key, value] of Object.entries(input)) {
    const rule = Object.prototype.hasOwnProperty.call(ATTRIBUTE_RULES, key)
      ? ATTRIBUTE_RULES[key as TelemetryAttributeName]
      : undefined
    if (!rule) continue // имени нет в белом списке
    if (value === undefined || value === null) continue

    let candidate: TelemetryValue
    if (typeof value === 'number') {
      // NaN/Infinity — мусор, который экспортёр отдаст как «null» или уронит сериализацию.
      if (!Number.isFinite(value)) continue
      candidate = value
    } else if (typeof value === 'boolean') {
      candidate = value
    } else if (typeof value === 'string') {
      // `toSingleLine` вычищает управляющие и bidi-символы (NUL, ESC, RLO, zero-width) и схлопывает
      // пробелы. Одного `\s+` тут не хватало: ANSI-escape и NUL проходили насквозь и в терминальном
      // просмотрщике оператора перекрашивали и подделывали соседние поля, а RLO переворачивал текст.
      candidate = toSingleLine(value).slice(0, MAX_ATTRIBUTE_LENGTH)
      if (!candidate) continue
    } else {
      // Объект, массив, функция, symbol, bigint: скаляр — граница по замыслу.
      continue
    }

    // Форма значения обязана совпасть с объявленной для этого имени.
    if (rule(candidate)) out[key] = candidate
  }
  return out as Partial<Record<TelemetryAttributeName, TelemetryValue>>
}

/** Длина хеша портала в hex-символах. 16 — 64 бита: столкновений на нашем числе порталов не бывает. */
export const PORTAL_HASH_LENGTH = 16

/**
 * Хеш портала для трейсов.
 *
 * Не «анонимизация» в юридическом смысле: множество порталов невелико, и по хешу при желании можно
 * перебрать member_id. Задача скромнее и достижима — чтобы идентификатор заказчика не лежал в чужом
 * хранилище в открытом виде и не искался по нему поиском. Для разбора инцидента этого достаточно:
 * нужен лишь признак «тот же портал или другой».
 */
export function portalHash(memberId: unknown): string | undefined {
  // `unknown`, а не `string`: member_id приходит из JSON-тел и строк БД, где типу верят на слово, —
  // а `TypeError` здесь превратился бы в 500 в роуте из-за телеметрии.
  const id = typeof memberId === 'string' ? memberId.trim() : ''
  if (!id) return undefined
  return createHash('sha256').update(id).digest('hex').slice(0, PORTAL_HASH_LENGTH)
}

/** Виды ошибок, которые мы различаем. Закрытый набор — иначе это снова свободная строка. */
export const ERROR_KINDS = ['timeout', 'network', 'auth', 'rate_limit', 'not_found', 'bad_response', 'other'] as const
export type ErrorKind = (typeof ERROR_KINDS)[number]

/**
 * Вид ошибки вместо её текста.
 *
 * Классифицируем по признакам, а не пересказываем сообщение: в текст уже попадали строка подключения к
 * БД и адрес REST с токеном в query. На вопрос «что сломалось» вид отвечает, а унести с собой ничего
 * не может.
 *
 * ⚠️ Сопоставление идёт по подстрокам сообщения — то есть по чужому тексту, который может измениться с
 * версией библиотеки. Это осознанный компромисс: неверная классификация даёт `other`, то есть теряется
 * точность, а не приватность. Обратный порядок (сначала отдать текст, потом чистить) отдал бы точность
 * за счёт приватности, и это недопустимо.
 */
export function errorKind(e: unknown): ErrorKind {
  // ⚠️ Чтение `name`/`message` обёрнуто: у наследника Error геттер может бросить, и тогда исключение
  // вылетело бы ИЗ catch-блока обёртки, подменив настоящую ошибку вызывающего. Телеметрия не имеет
  // права менять то, что увидит вызывающий, — даже собственным сбоем.
  let hay = ''
  try {
    const name = e instanceof Error ? String(e.name) : ''
    const msg = e instanceof Error ? String(e.message) : typeof e === 'string' ? e : ''
    hay = `${name} ${msg}`.toLowerCase()
  } catch {
    return 'other'
  }

  if (/aborterror|timeout|timed out|etimedout|aborted/.test(hay)) return 'timeout'
  if (/econnrefused|econnreset|enotfound|eai_again|socket hang up|fetch failed|network/.test(hay)) return 'network'
  if (/invalid_grant|invalid_token|expired_token|unauthorized|\b401\b|\b403\b/.test(hay)) return 'auth'
  if (/query_limit_exceeded|operation_time_limit|too many requests|\b429\b/.test(hay)) return 'rate_limit'
  if (/not_found|\b404\b/.test(hay)) return 'not_found'
  if (/unexpected|malformed|invalid json|parse/.test(hay)) return 'bad_response'
  return 'other'
}

/**
 * Включена ли телеметрия.
 *
 * Единственный признак — задан ли адрес коллектора. Отдельного флага «включить» нет намеренно: два
 * рычага рано или поздно разъезжаются, и появляется состояние «адрес есть, флага нет», где непонятно,
 * почему трейсов не видно. Нет адреса — некуда отправлять, значит выключено.
 */
export function telemetryEnabled(env: Record<string, string | undefined>): boolean {
  return Boolean((env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').trim())
}

/**
 * Стадии исходящих вызовов к Bitrix24 — ЗАКРЫТЫЙ набор.
 *
 * Почему набор, а не URL. В адресе портала стоит его домен (`acme.bitrix24.by`), то есть имя заказчика,
 * а в query у некоторых путей ещё и токен. Положить URL в спан значит отдать и то и другое. Стадия
 * отвечает на вопрос «что мы делали» — этого хватает для разбора, и унести с собой она ничего не может.
 */
export const OUTGOING_STAGES = ['profile', 'oauth.refresh', 'other'] as const
export type OutgoingStage = (typeof OUTGOING_STAGES)[number]

/**
 * Атрибуты исходящего HTTP-вызова, выведенные из его адреса.
 *
 * Домен портала НЕ попадает в спан ни в каком виде — только его хеш, тот же {@link portalHash}. Для
 * OAuth-сервера хеш не проставляется: хост там один на всех, различать нечего, а лишний атрибут — лишний
 * повод его однажды разлогировать.
 */
export function outgoingCallAttributes(url: string): { stage: OutgoingStage, 'portal.hash'?: string } {
  let host = ''
  let path = ''
  try {
    const u = new URL(url)
    host = u.hostname.toLowerCase()
    path = u.pathname
  } catch {
    return { stage: 'other' }
  }
  if (host === 'oauth.bitrix.info') return { stage: 'oauth.refresh' }
  const stage: OutgoingStage = path.endsWith('/rest/profile') ? 'profile' : 'other'
  const hash = portalHash(host)
  return hash ? { stage, 'portal.hash': hash } : { stage }
}

/** Кап длины имени спана. Имя — метка операции, а не место для содержимого. */
export const MAX_SPAN_NAME_LENGTH = 80

/**
 * Имя спана, пригодное к отправке.
 *
 * Белый список атрибутов имени не касается, а имя уезжает в трейс так же — то есть это второй канал
 * тех же данных: `withSpan(err.message, …)` отправил бы текст ошибки мимо всей защиты. Поэтому вычищаем
 * управляющие и bidi-символы, схлопываем пробелы и режем по капу. Пусто → `unnamed`, а не пустая строка:
 * безымянный спан в интерфейсе коллектора неотличим от сбоя.
 */
export function safeSpanName(name: unknown): string {
  const flat = toSingleLine(name).slice(0, MAX_SPAN_NAME_LENGTH)
  return flat || 'unnamed'
}
