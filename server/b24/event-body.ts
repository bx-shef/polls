/**
 * Parses the raw body of a Bitrix24 event POST.
 *
 * Формат подтверждён документацией: общая страница про события прямо говорит, что запрос
 * приходит с `content-type: application/x-www-form-urlencoded`, а JSON в примерах только
 * показывает структуру. То есть тело — это форма с ключами в скобках, `auth[member_id]=…`,
 * и собрать из неё дерево обязаны мы.
 *
 * Разбор идёт от **сырого** тела, а не от разобранного HTTP-слоем объекта: так формат
 * не зависит от того, что решит про него h3, и обработчик ведёт себя одинаково
 * независимо от версии сервера.
 *
 * Портировано с `client-bank-alfa-by`, `app/utils/b24Events.ts::parseBracketForm` —
 * там эта функция обслуживает живые порталы. Свой вариант писать незачем.
 */

/**
 * Ключи, через которые внешнее тело дотянулось бы до прототипа.
 * Адрес обработчика публичный, а `application_token` проверяется уже ПОСЛЕ разбора.
 */
const POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * `event=ONAPPINSTALL&auth[member_id]=abc` → `{ event: 'ONAPPINSTALL', auth: { member_id: 'abc' } }`.
 *
 * Все листья — строки: форма не несёт типов. Числа вроде `expires_in` приезжают строкой,
 * и разбирать их — дело того, кто читает грант.
 */
export function parseBracketForm(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  for (const [key, value] of new URLSearchParams(raw)) {
    // `data[bot][id]` → ['data', 'bot', 'id']
    const path = key.replace(/\]/g, '').split('[')
    if (path.some(segment => POLLUTING_KEYS.has(segment))) continue

    let node: Record<string, unknown> = out
    for (let i = 0; i < path.length; i++) {
      const segment = path[i] as string
      if (i === path.length - 1) {
        node[segment] = value
        break
      }
      if (typeof node[segment] !== 'object' || node[segment] === null) {
        node[segment] = {}
      }
      node = node[segment] as Record<string, unknown>
    }
  }

  return out
}

/**
 * Код события, приведённый к верхнему регистру: маршрутизация не должна зависеть
 * от того, написал портал `OnAppInstall` или `ONAPPINSTALL`.
 */
export function eventCode(payload: unknown): string {
  const code = (payload as { event?: unknown } | null)?.event
  return typeof code === 'string' ? code.toUpperCase() : ''
}
