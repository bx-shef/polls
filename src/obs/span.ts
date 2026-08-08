/**
 * Спаны: обёртка над `@opentelemetry/api`.
 *
 * **Почему отдельная обёртка, а не вызовы API по месту.** Прямой вызов `tracer.startActiveSpan` в
 * каждой точке означает, что правила приватности соблюдает автор каждой такой точки. Мы уже видели,
 * чем это заканчивается на примере капов размера тела: правило, которое нужно помнить, забывается, а
 * забывший код внешне неотличим от правильного. Здесь та же логика: атрибуты в спан попадают **только**
 * через {@link pickSafeAttributes}, и обойти это, пользуясь обёрткой, нельзя.
 *
 * ⚠️ **`span.recordException` не используется НИКОГДА, и это главное правило файла.** Он кладёт в спан
 * `exception.message` и `exception.stacktrace` — то есть свободный текст из чужой библиотеки, ровно тот
 * канал, которым в трейсы уезжают строка подключения к БД и адрес REST с токеном. Вместо него — вид
 * ошибки ({@link errorKind}). По той же причине статусу спана не передаётся `message`.
 *
 * **Пока SDK не зарегистрирован, спаны no-op.** `@opentelemetry/api` без SDK отдаёт пустой трейсер:
 * спан не создаётся и никуда не отправляется. ⚠️ Но «no-op» здесь не значит «бесплатно»:
 * `pickSafeAttributes(attrs)` — обычный аргумент, он вычисляется ВСЕГДА, как и шаблон имени спана, а на
 * ошибке ещё и {@link errorKind}. Цена — перебор объекта из нескольких полей, поэтому в горячие пути
 * ставить можно; но утверждать «стоимость нулевая» было бы неправдой.
 */

import { SpanKind, SpanStatusCode, trace, type Span } from '@opentelemetry/api'
import { errorKind, pickSafeAttributes, MAX_SPAN_NAME_LENGTH, safeSpanName } from './telemetry'

/** Имя инструментирующей библиотеки в трейсах — наш сервис. */
export const TRACER_NAME = 'polls'

/**
 * Один трейсер на модуль — штатная практика OTel, и `ProxyTracer` для этого и существует: он
 * переключится на настоящий, когда SDK зарегистрируется позже. `trace.getTracer()` не мемоизирован
 * (проверено: два вызова дают разные объекты), а зовётся он у нас на каждый REST-вызов.
 */
const tracer = trace.getTracer(TRACER_NAME)

/**
 * Обернуть операцию спаном.
 *
 * `attrs` проходит через белый список: неизвестное имя не попадёт в спан, что бы ни передал вызывающий.
 * Исход и вид ошибки проставляются здесь же, чтобы каждый вызывающий не повторял это руками (и не
 * забывал).
 *
 * Ошибка **пробрасывается дальше** — телеметрия не меняет поведение кода, который наблюдает.
 */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, unknown>,
  fn: () => Promise<T>,
  kind: SpanKind = SpanKind.INTERNAL
): Promise<T> {
  // ⚠️ Всё, что относится к спану, обёрнуто и НЕ может повлиять на наблюдаемый код. Ревью показало,
  // что без этого телеметрия меняла поведение сразу двумя способами: синхронный throw в
  // `startActiveSpan` вообще отменял бизнес-вызов (портал не получал запроса), а throw в
  // `setStatus`/`end` превращал успешный вызов в ошибку и терял результат. Для нашего же плана это не
  // гипотеза: анонсированный redaction-процессор вызывается синхронно в `onStart` внутри `startSpan`,
  // то есть один баг в нём убил бы все вызовы к Bitrix24.
  // ⚠️ Имя спана — ВТОРОЙ канал тех же данных, и белый список его не касается: `withSpan(err.message)`
  // отправил бы текст ошибки в трейс мимо всей защиты. Поэтому имя тоже вычищается и капается.
  const spanName = safeSpanName(name)
  const attributes = quiet(() => pickSafeAttributes(attrs)) ?? {}
  let started: ReturnType<typeof tracer.startActiveSpan<(span: Span) => Promise<T>>> | undefined
  try {
    started = tracer.startActiveSpan(spanName, { kind, attributes }, async (span) => {
      try {
        const result = await fn()
        quiet(() => span.setStatus({ code: SpanStatusCode.OK }))
        return result
      } catch (e) {
        // Вид ошибки, а НЕ её текст и НЕ recordException: см. шапку файла.
        quiet(() => span.setAttribute('error_kind', errorKind(e)))
        // Без `message`: статус спана — тоже поле для свободной строки.
        quiet(() => span.setStatus({ code: SpanStatusCode.ERROR }))
        throw e
      } finally {
        quiet(() => span.end())
      }
    })
  } catch {
    // Трейсер сломался ДО того, как отдал управление в `fn`, — значит операция ещё не выполнялась.
    // Выполняем её без спана: наблюдение не имеет права отменять наблюдаемое.
    return await fn()
  }
  return await started
}

/**
 * Выполнить действие над спаном, проглотив его сбой.
 *
 * Единственное место в проекте, где проглатывание ошибки правильно: телеметрия обязана быть невидимой
 * для наблюдаемого кода, и её собственный сбой не должен ни ронять запрос, ни подменять ошибку. В лог
 * тоже НЕ пишем: сломанный экспортёр сбоит на каждом вызове, и лог захлебнулся бы.
 */
function quiet<R>(action: () => R): R | undefined {
  try {
    return action()
  } catch {
    return undefined
  }
}

/**
 * Спан исходящего вызова (к порталу Bitrix24, к OAuth-серверу).
 *
 * Отличается от {@link withSpan} только видом (`CLIENT`) — по нему в интерфейсе коллектора отделяют
 * «мы ждём чужой сервис» от «мы сами считаем». Это первое, что нужно знать при разборе «почему
 * медленно», и поэтому вид проставляется, а не остаётся дефолтным.
 */
export async function withDependencySpan<T>(
  name: string,
  attrs: Record<string, unknown>,
  fn: () => Promise<T>
): Promise<T> {
  return await withSpan(name, attrs, fn, SpanKind.CLIENT)
}
