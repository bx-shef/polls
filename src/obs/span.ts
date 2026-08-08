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
 * **Пока SDK не зарегистрирован, всё это no-op.** `@opentelemetry/api` без SDK отдаёт пустой трейсер:
 * спаны не создаются, атрибуты не считаются, стоимость — вызов функции. Поэтому обёртку можно ставить
 * в горячие пути до появления коллектора, и это не «мёртвый код», а заявленное состояние по умолчанию:
 * нет адреса коллектора — нет телеметрии.
 */

import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import { errorKind, pickSafeAttributes } from './telemetry'

/** Имя инструментирующей библиотеки в трейсах — наш сервис. */
export const TRACER_NAME = 'polls'

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
  const tracer = trace.getTracer(TRACER_NAME)
  return await tracer.startActiveSpan(name, { kind, attributes: pickSafeAttributes(attrs) }, async (span) => {
    try {
      const result = await fn()
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (e) {
      // Вид ошибки, а НЕ её текст и НЕ recordException: см. шапку файла.
      span.setAttribute('error_kind', errorKind(e))
      // Без `message`: статус спана — тоже поле для свободной строки.
      span.setStatus({ code: SpanStatusCode.ERROR })
      throw e
    } finally {
      span.end()
    }
  })
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
