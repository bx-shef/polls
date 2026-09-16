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
  const url = handlerUrl.trim()
  if (!/^https:\/\/[^\s/]+\/\S*$/i.test(url)) return null

  return {
    method: 'placement.bind',
    params: {
      PLACEMENT: DEAL_TAB_PLACEMENT,
      HANDLER: url,
      TITLE: DEAL_TAB_TITLE,
      LANG_ALL: { ru: { TITLE: DEAL_TAB_TITLE }, en: { TITLE: 'Surveys' } },
    },
  }
}

/** Снять регистрацию — единственный способ сменить адрес обработчика (см. шапку). */
export function buildUnbindDealTabCall(handlerUrl?: string): PortalCall {
  const url = (handlerUrl ?? '').trim()
  return {
    method: 'placement.unbind',
    params: { PLACEMENT: DEAL_TAB_PLACEMENT, ...(url === '' ? {} : { HANDLER: url }) },
  }
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
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (!/^https:\/\/[^\s/]+$/i.test(trimmed)) return null
  return `${trimmed}${DEAL_TAB_PATH}`
}
