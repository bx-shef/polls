import { parsePlacementOptions } from './placement'

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
 * Куда вести фрейм, открытый с этими параметрами: `/help` с якорем, `/help` без него или никуда.
 *
 * ⚠ Якорь СВЕРЯЕТСЯ с разделами справки, а не подставляется как есть. `place` приходит из портала,
 * то есть снаружи, и непроверенное значение уехало бы прямо в адрес фрейма. Заодно это ловит
 * опечатку в ссылке: неизвестный якорь открывает справку с начала, а не пустое место.
 *
 * Разделы приходят параметром (`FAQ.map(entry => entry.id)` у вызывающего), а не импортом
 * `shared/faq.ts` отсюда: код `app/` берёт общий модуль только через `#shared` — относительный путь
 * сборка выносит наружу с неверным адресом (поймано сборкой), — а юнит-тестам этот псевдоним
 * недоступен. Чистая функция от списка разделов проверяется и без Nuxt.
 */
export function helpRouteFor(options: unknown, anchors: readonly string[]): { path: '/help', hash: string } | null {
  const bag = parsePlacementOptions(options)
  const key = Object.keys(bag).find(name => name.toLowerCase() === 'place')
  const place = key === undefined ? undefined : bag[key]
  if (typeof place !== 'string' || !place.startsWith(HELP_PLACE_PREFIX)) return null

  const anchor = place.slice(HELP_PLACE_PREFIX.length)
  return { path: '/help', hash: anchors.includes(anchor) ? `#${anchor}` : '' }
}
