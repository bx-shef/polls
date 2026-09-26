import { placementValue } from './placement'

/**
 * Opening the help in the portal's slider, straight at the right section.
 *
 * ⚠ КАНАЛ ОДИН — `place`. Слайдер приложения портал открывает по НАШЕМУ же адресу приложения
 * (`/app`), а всё, что передали в `openSliderAppPage`, отдаёт фрейму в `PLACEMENT_OPTIONS`
 * (документация SDK, `frame-slider`). Строку запроса фрейму задаёт портал, хэш до фрейма не доезжает
 * вовсе — значит, якорь раздела может приехать только внутри `place`. Приём взят у соседнего проекта
 * (`client-bank-alfa-by`, `app/config/b24.ts`).
 *
 * ⚠ Якорь, а не «открыть справку»: ссылку ставят там, где человек застрял, и оглавление вместо
 * ответа вернуло бы его к поиску своего вопроса.
 */

/** Префикс `place` для справки: `help-<якорь раздела>`. */
export const HELP_PLACE_PREFIX = 'help-'

/**
 * Ширина слайдера справки, пикселей.
 *
 * Страница справки — одна колонка текста шириной до 820 px; уже 640 брейкпоинт `sm` отдал бы ей
 * мобильную вёрстку — внутри слайдера медиазапросы считаются от ширины фрейма. 720 — запас над ним.
 */
export const HELP_SLIDER_WIDTH = 720

/** `place` для ссылки на раздел справки. */
export function helpPlace(anchor: string): string {
  return `${HELP_PLACE_PREFIX}${anchor}`
}

/**
 * Форма якоря: та же, что у `id` разделов справки (её держит `tests/unit/faq.test.ts`).
 *
 * ⚠ Проверка по ФОРМЕ, а не по списку разделов. Список пришлось бы тянуть в `/app` вместе со всем
 * текстом справки — десятки килобайт в чанк главной страницы, которые грузятся при каждом открытии
 * из меню. А защищает здесь именно форма: из `place` в адрес не может попасть ничего, кроме
 * строчных латинских букв, цифр и дефиса. Неизвестный, но правильный по форме якорь открывает
 * справку с начала — у страницы просто нет раздела с таким `id`. Нашёл `/code-review` в PR #82.
 */
const ANCHOR_SHAPE = /^[a-z][a-z0-9-]{0,40}$/

/**
 * Куда вести фрейм, открытый с этими параметрами: `/help` с якорем, `/help` без него или никуда.
 *
 * ⚠ Якорь из `place` проверяется, а не подставляется как есть: `place` приходит из портала, то есть
 * снаружи, и непроверенное значение уехало бы прямо в адрес фрейма.
 */
export function helpRouteFor(options: unknown): { path: '/help', hash: string } | null {
  const place = placementValue(options, 'place')
  if (typeof place !== 'string' || !place.startsWith(HELP_PLACE_PREFIX)) return null

  const anchor = place.slice(HELP_PLACE_PREFIX.length)
  return { path: '/help', hash: ANCHOR_SHAPE.test(anchor) ? `#${anchor}` : '' }
}

/**
 * Сколько ждать быстрого ответа портала на просьбу открыть слайдер, миллисекунд.
 *
 * ⚠ Ждём именно БЫСТРЫЙ ответ, а не завершение. Промис `openSliderAppPage` портал завершает, когда
 * слайдер ЗАКРЫВАЮТ: пока человек читает справку, он висит, и это штатно. Отказ же приходит сразу
 * ответом-ошибкой — так его разбирает сам SDK в `openPath` (`result: 'error'`,
 * `METHOD_NOT_SUPPORTED_ON_DEVICE` в мобильном клиенте). Ждать завершения значило бы никогда
 * не дождаться отказа — первая редакция так и делала, и запасной путь внутри портала был
 * недостижим. Нашли `/review`, `/code-review` и тестировщик в PR #82.
 */
export const SLIDER_ANSWER_MS = 1000

/** Пометка «портал за отведённое время не ответил» — то есть слайдер открыт и ждёт закрытия. */
export const SLIDER_PENDING = Symbol('slider-pending')

/**
 * Отказал ли портал открыть слайдер.
 *
 * `SLIDER_PENDING` — не отказ: слайдер открыт. Ответ-ошибка или исключение — отказ.
 */
export function isSliderRefusal(answer: unknown): boolean {
  if (answer === SLIDER_PENDING) return false
  if (answer instanceof Error) return true
  return (answer as { result?: unknown } | null)?.result === 'error'
}
