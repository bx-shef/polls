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

/** Что портал передал фрейму поля нашего типа. */
export interface FieldContext {
  /** Карточка в режиме правки. Виджет и тогда только показывает: `setValue` мы не зовём. */
  editing: boolean
  /** Чей это объект: `CRM_<id смарт-процесса>`. Пусто — портал не прислал. */
  entityId: string
  /** Тип объекта из `ENTITY_DATA`. `null` — не прислал. */
  entityTypeId: number | null
  /** Номер элемента. `null` — новая, ещё не сохранённая карточка: портал шлёт там `0`. */
  itemId: number | null
}

/**
 * Разобрать параметры фрейма поля своего типа.
 *
 * ⚠ ИСТОЧНИКОВ ДВА, и расходятся они не по нашей вине. Официальный гайд «Как встроить виджет
 * в лид в виде пользовательского поля» перечисляет `MODE`, `ENTITY_ID`, `ENTITY_VALUE_ID`.
 * Соседнее приложение (`nuxt-uf-legat-info`, `app/pages/handler/uf.legat-info.html.client.vue`)
 * на живых порталах читает `ENTITY_DATA.entityId` и `ENTITY_DATA.entityTypeId`, которых
 * в гайде нет. Берём документированное первым, наблюдаемое — вторым: расхождение мы не выбирали,
 * и промах любого из двух значил бы поле, которое не показывает ничего.
 *
 * Те же три ловушки, что у вкладок (шапка файла): строка вместо объекта, чужой регистр ключей,
 * пустые параметры. Поэтому разбор здесь, а не обращением по точке в странице.
 */
export function fieldContext(options: unknown): FieldContext {
  const bag = parsePlacementOptions(options)
  const data = parsePlacementOptions(placementValue(bag, 'ENTITY_DATA'))
  const mode = placementValue(bag, 'MODE')
  const entityId = placementValue(bag, 'ENTITY_ID')

  return {
    editing: typeof mode === 'string' && mode.trim().toLowerCase() === 'edit',
    entityId: typeof entityId === 'string' ? entityId.trim() : '',
    entityTypeId: numericValue(data, 'entityTypeId'),
    itemId: numericValue(bag, 'ENTITY_VALUE_ID') ?? numericValue(data, 'entityId'),
  }
}

/**
 * Значение ключа параметров фрейма без учёта регистра, как есть.
 *
 * ⚠ Экспортировано, чтобы второго разборщика не появлялось: справка читает `place` этой же
 * функцией (`app/utils/help.ts`). Своя копия означала бы две копии трёх ловушек из шапки файла —
 * и следующую найденную чинили бы в одной из них. Нашли `/review` и `/code-review` в PR #82.
 */
export function placementValue(options: unknown, key: string): unknown {
  const bag = parsePlacementOptions(options)
  const found = Object.keys(bag).find(name => name.toLowerCase() === key.toLowerCase())
  return found === undefined ? undefined : bag[found]
}
