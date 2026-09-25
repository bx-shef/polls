import type { PortalCall } from './smart-processes'

/**
 * Where the app embeds itself in the portal, and how that registration behaves.
 *
 * Форма взята у `client-bank-alfa-by` (`app/utils/b24PlacementRegister.ts`), где она оплачена
 * живыми порталами: чистый билдер здесь, транспорт у вызывающего.
 *
 * ⚠ Три свойства `placement.bind`, каждое из которых ломает установку, если о нём не знать:
 *
 * 1. Нужен КОНТЕКСТ ПРИЛОЖЕНИЯ. Вебхук не подойдёт — метод ответит `WRONG_AUTH_TYPE`.
 *    Наш токен из события установки контекст даёт.
 * 2. Метод НЕЛЬЗЯ класть в батч: `ERROR_BATCH_METHOD_NOT_ALLOWED`.
 * 3. Повторная регистрация точки, допускающей одну, ОТКАЗЫВАЕТ с `ERROR_PLACEMENT_MAX_COUNT`.
 *    На переустановке это штатный ответ «уже зарегистрировано», а не поломка. Считать его
 *    ошибкой — значит красить исправную установку в жёлтое.
 *
 * ⚠ Из третьего следует ловушка: сменить АДРЕС обработчика повторным `bind` нельзя, сначала
 * `placement.unbind`. Пока этого не сделали, портал продолжает открывать СТАРЫЙ адрес,
 * и снаружи это выглядит как «вкладка ведёт не туда» на свежем выкате.
 */

/** Вкладка в карточке сделки. Подтверждено туториалом «Как встроить виджет во вкладку карточки CRM». */
export const DEAL_TAB_PLACEMENT = 'CRM_DEAL_DETAIL_TAB'

/** Название вкладки, как его увидит сотрудник портала. */
export const DEAL_TAB_TITLE = 'Опросы'

/**
 * Вкладка в карточке элемента смарт-процесса — там живёт конструктор анкеты.
 *
 * ⚠ ЧИСЛО В КОДЕ — `entityTypeId`, А НЕ `id` СМАРТ-ПРОЦЕССА, и различать их здесь обязательно.
 * Документация точки говорит прямо: «у кода `CRM_DYNAMIC_183_DETAIL_TAB` идентификатор типа
 * равен 183», и это то же число, что уходит в `crm.item.get` параметром `entityTypeId`.
 * Спутать легко, потому что РЯДОМ, у имён пользовательских полей, правило ОБРАТНОЕ:
 * `UF_CRM_10_STATE` собирается из `id` (у нас 10) при `entityTypeId` 1040. Два соседних
 * механизма берут разные идентификаторы одного и того же смарт-процесса — замерено живьём
 * и записано в `docs/PROCESS.md`.
 *
 * ⚠ Неверный код портал отвергает `ERROR_PLACEMENT_NOT_FOUND`, а не молчит, — то есть ошибка
 * видна сразу. Это единственная приятная новость в этом абзаце.
 */
export function templateTabPlacement(entityTypeId: number): string {
  return `CRM_DYNAMIC_${entityTypeId}_DETAIL_TAB`
}

/** Название вкладки конструктора. */
export const TEMPLATE_TAB_TITLE = 'Конструктор'

/** Путь обработчика вкладки конструктора. */
export const TEMPLATE_TAB_PATH = '/portal/template-tab'

/** Ответ портала на повторную регистрацию точки, допускающей одну. */
export const PLACEMENT_ALREADY_BOUND = 'ERROR_PLACEMENT_MAX_COUNT'

/** Путь обработчика вкладки. Относительный: абсолютный собирается из публичного хоста портала. */
export const DEAL_TAB_PATH = '/portal/deal-tab'

/**
 * Построить регистрацию вкладки, либо `null` при негодном адресе.
 *
 * ⚠ Адрес обязан быть АБСОЛЮТНЫМ и `https`. Относительный портал принял бы, но открывал бы его
 * от СВОЕГО домена — то есть обработчиком стала бы страница портала, а не наша. Отказ здесь
 * честнее, чем регистрация заведомо неверного: снаружи вторая выглядит как работающая вкладка,
 * открывающая чужой сайт.
 */
export function buildBindDealTabCall(handlerUrl: string): PortalCall | null {
  return buildBindTabCall(DEAL_TAB_PLACEMENT, handlerUrl, DEAL_TAB_TITLE, 'Surveys')
}

/**
 * Регистрация вкладки — общая для всех точек `*_DETAIL_TAB`.
 *
 * Вынесено, когда вкладок стало две: у сделки и у «Шаблона опроса». Три свойства из шапки
 * (контекст приложения, запрет батча, одна регистрация на точку) у них одинаковы, и держать
 * два одинаковых построителя значило бы однажды починить только один.
 */
export function buildBindTabCall(
  placement: string,
  handlerUrl: string,
  title: string,
  titleEn: string,
): PortalCall | null {
  const url = handlerUrl.trim()
  if (!/^https:\/\/[^\s/]+\/\S*$/i.test(url)) return null

  return {
    method: 'placement.bind',
    params: {
      PLACEMENT: placement,
      HANDLER: url,
      TITLE: title,
      LANG_ALL: { ru: { TITLE: title }, en: { TITLE: titleEn } },
    },
  }
}

/**
 * Снять регистрацию — единственный способ сменить адрес обработчика (см. шапку).
 *
 * ⚠ БЕЗ `HANDLER`, и это принципиально. С адресом `placement.unbind` снимает только
 * регистрацию НА ЭТОТ адрес; без него — все регистрации точки, сделанные приложением
 * (подтверждено документацией метода). А снимать нам надо ровно то, чего мы не знаем:
 * СТАРЫЙ адрес. Передав сюда новый, получаем снятие вхолостую, следом `bind`, падающий
 * с `ERROR_PLACEMENT_MAX_COUNT`, — и портал продолжает открывать старый адрес, при том что
 * установка отчиталась успехом. Именно так и было написано сначала.
 *
 * Чужие регистрации этим не тронуть: метод работает в контексте приложения и видит только
 * свои. Параметра тут нет намеренно — передать в него нечего, кроме как ошибку.
 */
export function buildUnbindDealTabCall(): PortalCall {
  return buildUnbindTabCall(DEAL_TAB_PLACEMENT)
}

/** Снятие регистрации — общее для всех точек. Без `HANDLER`, разбор выше. */
export function buildUnbindTabCall(placement: string): PortalCall {
  return { method: 'placement.unbind', params: { PLACEMENT: placement } }
}

/**
 * Отличить «уже зарегистрировано» от настоящего отказа.
 *
 * ⚠ Смотрим на КОД ошибки, а не на её текст: текст портал отдаёт локализованным, и завтра он
 * придёт на другом языке. Код приезжает в разных обёртках — сырой конверт, объект ошибки SDK,
 * просто строка, — поэтому проверяем несколько форм, но именно код.
 */
export function isPlacementAlreadyBound(error: unknown): boolean {
  if (typeof error === 'string') return error.includes(PLACEMENT_ALREADY_BOUND)
  if (error === null || typeof error !== 'object') return false

  const bag = error as Record<string, unknown>
  for (const key of ['error', 'code', 'name', 'message']) {
    const value = bag[key]
    if (typeof value === 'string' && value.includes(PLACEMENT_ALREADY_BOUND)) return true
  }
  return false
}

/**
 * Абсолютный адрес обработчика вкладки.
 *
 * Хост берётся у портала, а не из константы: клиент со своим доменом получает и вкладку,
 * открывающую его адрес. Пусто или не `https` — `null`, и регистрация честно не состоится.
 */
export function buildDealTabHandlerUrl(baseUrl: string): string | null {
  return buildTabHandlerUrl(baseUrl, DEAL_TAB_PATH)
}

/** Тот же адрес для любой вкладки: хост портала плюс путь обработчика. */
export function buildTabHandlerUrl(baseUrl: string, path: string): string | null {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (!/^https:\/\/[^\s/]+$/i.test(trimmed)) return null
  return `${trimmed}${path}`
}
