/**
 * Разбор `application/x-www-form-urlencoded` c bracket-нотацией Bitrix24 в неглубоко-вложенный
 * объект. Bitrix шлёт события формой: `event=ONAPPUNINSTALL&auth[member_id]=..&auth[application_token]=..
 * &data[CLEAN]=1&ts=123` — h3/URLSearchParams отдаёт ПЛОСКИЕ ключи с литеральными скобками, поэтому
 * `auth[member_id]` нужно собрать в `{ auth: { member_id } }` перед zod-парсом события.
 *
 * ⚠️ ТОЛЬКО ОДИН уровень вложенности (`parent[child]`) — достаточно для install/**uninstall**-событий
 * (`auth[x]`/`data[CLEAN]`). НЕ подходит для 2-уровневых, напр. `ONCRMDEALUPDATE` (`data[FIELDS][ID]`):
 * такой ключ не матчит регэксп и упадёт в плоскую ветку (значение НЕ вложится, `data` будет undefined).
 * Перед переиспользованием для #17 (deal-event) — обобщить на произвольную глубину.
 * Идемпотентно на уже вложенном входе (JSON-тело: ключ без скобок → значение-объект проходит как есть).
 * Гард от prototype-pollution: ключи `__proto__`/`prototype`/`constructor` (родитель или потомок) отбрасываются.
 */

const DANGEROUS = new Set(['__proto__', 'prototype', 'constructor'])
const BRACKET = /^([^[\]]+)\[([^[\]]+)\]$/

export function parseBracketForm(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [rawKey, value] of Object.entries(flat)) {
    const m = BRACKET.exec(rawKey)
    if (m) {
      const parent = m[1]!
      const child = m[2]!
      if (DANGEROUS.has(parent) || DANGEROUS.has(child)) continue
      const existing = out[parent]
      const bucket = (existing && typeof existing === 'object' ? existing : (out[parent] = {})) as Record<string, unknown>
      bucket[child] = value
    } else {
      if (DANGEROUS.has(rawKey)) continue
      out[rawKey] = value
    }
  }
  return out
}
