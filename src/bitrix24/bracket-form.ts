/**
 * Разбор `application/x-www-form-urlencoded` c bracket-нотацией Bitrix24 во вложенный объект.
 * Bitrix шлёт события формой: `event=ONAPPUNINSTALL&auth[member_id]=..&auth[application_token]=..
 * &data[CLEAN]=1&ts=123` — h3/URLSearchParams отдаёт ПЛОСКИЕ ключи с литеральными скобками, поэтому
 * `auth[member_id]` нужно собрать в `{ auth: { member_id } }` перед zod-парсом события.
 *
 * **Произвольная глубина** (`parent[a][b][c]` → `{ parent: { a: { b: { c: value } } } }`) — покрывает и
 * 1-уровневые install/**uninstall** (`auth[x]`/`data[CLEAN]`), и 2-уровневый `ONCRMDEALUPDATE`
 * (`data[FIELDS][ID]` → `{ data: { FIELDS: { ID } } }`, #17). Ключ парсится как «голова + цепочка `[сегмент]`»;
 * ключ с несбалансированными/пустыми скобками (`a[]`, `a[b`) в путь не раскладывается — идёт плоским литералом.
 * Идемпотентно на уже вложенном входе (JSON-тело: ключ без скобок → значение-объект проходит как есть).
 * Гард от prototype-pollution: если ЛЮБОЙ сегмент пути — `__proto__`/`prototype`/`constructor`, ключ отбрасывается.
 */

const DANGEROUS = new Set(['__proto__', 'prototype', 'constructor'])
// Голова (до первой скобки) + необязательная цепочка `[сегмент]` до конца строки. Сегмент — непустой, без скобок.
const BRACKET_KEY = /^([^[\]]+)((?:\[[^[\]]+\])*)$/
const SEGMENT = /\[([^[\]]+)\]/g

/** Разложить ключ формы в путь сегментов: `data[FIELDS][ID]` → `['data','FIELDS','ID']`; `null` — не bracket-ключ. */
function keyToPath(rawKey: string): string[] | null {
  const m = BRACKET_KEY.exec(rawKey)
  if (!m) return null // несбалансированные/пустые скобки — не раскладываем (плоский литерал)
  const path = [m[1]!]
  SEGMENT.lastIndex = 0
  let sm: RegExpExecArray | null
  while ((sm = SEGMENT.exec(m[2]!)) !== null) path.push(sm[1]!)
  return path
}

export function parseBracketForm(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [rawKey, value] of Object.entries(flat)) {
    const path = keyToPath(rawKey)
    if (!path) {
      if (!DANGEROUS.has(rawKey)) out[rawKey] = value
      continue
    }
    if (path.some((seg) => DANGEROUS.has(seg))) continue // опасный сегмент где угодно в пути → отброс
    // Идём по пути, создавая недостающие узлы; не-объект под промежуточным ключом вытесняется новым `{}`.
    let node = out
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i]!
      const existing = node[k]
      node = (existing && typeof existing === 'object' ? existing : (node[k] = {})) as Record<string, unknown>
    }
    node[path[path.length - 1]!] = value
  }
  return out
}
