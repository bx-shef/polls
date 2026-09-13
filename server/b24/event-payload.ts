/**
 * Normalizes the body of a portal event into a nested object.
 *
 * Документация показывает тело события как JSON, но по всей остальной документации видно,
 * что портал шлёт его как обычную форму: примеры обработчиков читают `$_REQUEST['auth']`,
 * а PHP собирает вложенность из ключей вида `auth[domain]`. Поэтому принимаем оба вида —
 * и форму, и JSON, — а какой приезжает на самом деле, покажет `pnpm verify:install`
 * на живом портале. Расхождение записано в `docs/PROCESS.md`.
 *
 * Разбор скобочной записи — единственная причина существования этого файла. Своего парсера
 * форм здесь нет: плоские пары уже разобрал HTTP-слой, мы только собираем из них дерево.
 */

/** Максимальная глубина вложенности. События портала плоские, дерево из ста уровней — это атака. */
const MAX_DEPTH = 4

/**
 * `auth[domain]` → `['auth', 'domain']`. Ключ без скобок остаётся одним сегментом.
 * Возвращает `null`, если скобки не сходятся: молча склеить такой ключ значит
 * положить значение не туда, куда его адресовали.
 */
function segments(key: string): string[] | null {
  const head = key.indexOf('[')
  if (head === -1) return key === '' ? null : [key]

  const path = [key.slice(0, head)]
  let rest = key.slice(head)
  while (rest !== '') {
    if (!rest.startsWith('[')) return null
    const close = rest.indexOf(']')
    if (close === -1) return null
    path.push(rest.slice(1, close))
    rest = rest.slice(close + 1)
  }
  return path.length > MAX_DEPTH ? null : path
}

/**
 * Собрать плоские пары формы в объект.
 *
 * Тело, уже пришедшее деревом (JSON), возвращается как есть: признак — отсутствие ключей
 * со скобками. Так один обработчик переживает оба формата, и переключать его руками
 * не придётся.
 */
export function nestEventBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null) return {}

  const flat = body as Record<string, unknown>
  const out: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(flat)) {
    const path = segments(key)
    if (path === null) continue

    let node = out
    for (let i = 0; i < path.length - 1; i++) {
      const step = path[i]!
      // `__proto__` и соседи в ключе — прямой путь к загрязнению прототипа,
      // а ключи здесь приходят из внешнего запроса.
      if (step === '__proto__' || step === 'constructor' || step === 'prototype') return {}
      const next = node[step]
      if (typeof next !== 'object' || next === null) node[step] = {}
      node = node[step] as Record<string, unknown>
    }

    const leaf = path[path.length - 1]!
    if (leaf === '__proto__' || leaf === 'constructor' || leaf === 'prototype') return {}
    node[leaf] = value
  }

  return out
}
