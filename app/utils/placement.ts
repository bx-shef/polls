/**
 * Reads which entity the portal opened our frame for.
 *
 * ⚠ Форма того, что приходит, НЕ зафиксирована, и это оплачено живыми порталами у соседнего
 * проекта (`client-bank-alfa-by`, `app/utils/placementOptions.ts`). Три вещи, каждая из которых
 * молча ломает вкладку:
 *
 * 1. `PLACEMENT_OPTIONS` приходит то объектом, то JSON-строкой — наивное `options.ID` в половине
 *    случаев даёт `undefined`, и вкладка показывает «сделка не определена» на живой сделке.
 * 2. Регистр ключей не наш: портал шлёт `ID` заглавными, но встречается и `id`.
 * 3. Параметры бывают пусты ЦЕЛИКОМ. Тогда второй штатный источник — адрес самого фрейма.
 *
 * Поэтому здесь чистые функции с тестами, а не пара обращений по точке в компоненте.
 */

/** Разобрать `PLACEMENT_OPTIONS`: он приходит объектом либо JSON-строкой. */
export function parsePlacementOptions(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
    }
    catch {
      return {}
    }
  }
  return raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
}

/**
 * Идентификатор сделки, ради которой открыта вкладка.
 *
 * Ищем и в параметрах фрейма, и в адресе: второй источник не «на всякий случай», а штатный —
 * у соседа встречался фрейм, которому портал не положил параметры вовсе.
 */
export function dealIdFrom(options: unknown, query: Record<string, unknown> = {}): number | null {
  return placementItemId(options, query)
}

/**
 * Идентификатор элемента, ради которого открыта вкладка, — для любой точки `*_DETAIL_TAB`.
 *
 * ⚠ Ключ ОДИН И ТОТ ЖЕ у всех точек этого семейства: документация говорит про `ID` и прямо
 * отмечает, что «идентификатор типа объекта отдельным ключом не приходит». То есть у вкладки
 * в карточке «Шаблона опроса» контекст выглядит ровно как у сделки, и второй разборщик
 * означал бы две копии трёх ловушек из шапки этого файла.
 */
export function placementItemId(options: unknown, query: Record<string, unknown> = {}): number | null {
  return numericValue(options, 'ID') ?? numericValue(query, 'id') ?? null
}

/** Значение ключа без учёта регистра, приведённое к положительному целому. */
function numericValue(source: unknown, key: string): number | null {
  const bag = parsePlacementOptions(source)
  for (const [name, value] of Object.entries(bag)) {
    if (name.toLowerCase() !== key.toLowerCase()) continue
    const numeric = Number(typeof value === 'string' ? value.trim() : value)
    return Number.isInteger(numeric) && numeric > 0 ? numeric : null
  }
  return null
}
