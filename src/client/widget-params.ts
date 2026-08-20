/**
 * Параметры, с которыми открывается виджет карточки сделки.
 *
 * Виджет открывается ДВУМЯ способами, и это разные ситуации:
 *  1. **из карточки сделки** (плейсмент `CRM_DEAL_DETAIL_ACTIVITY`) — портал кладёт `{ ID: '759' }`;
 *     приглашения ещё нет, менеджер жмёт «Создать ссылку»;
 *  2. **кнопкой «Отправить приглашение»** на деле в таймлайне (`openRestApp` с `actionParams`) —
 *     приглашение УЖЕ выписано автотриггером, и в параметрах едет его токен.
 *
 * ⚠️ Различать их обязательно. Если во втором случае виджет поведёт себя как в первом, он выпишет
 * ВТОРОЕ приглашение на ту же сделку — то есть ровно дубль, от которого мы избавлялись (#138), только
 * сделанный руками менеджера. У клиента при этом окажутся две ссылки, а первая умрёт при ответе по
 * второй.
 *
 * ⚠️ Разбор терпимый к форме намеренно: `placement.options` приходит из портала недоверенным JSON, а
 * Bitrix24 отдаёт id то числом, то строкой и по-разному именует ключи в разных плейсментах. Строгий
 * разбор здесь означал бы «кнопка молча не работает», и понять это по симптому было бы нечем.
 */
export interface WidgetParams {
  /** Сделка, в карточке которой открыт виджет. */
  dealId?: number
  /** Ключ опроса — есть только при открытии кнопкой из таймлайна. */
  surveyKey?: string
  /** Токен УЖЕ выписанного приглашения — есть только при открытии кнопкой из таймлайна. */
  token?: string
}

/** Прочитать значение по нескольким возможным именам ключа (портал именует по-разному). */
function pick(src: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) {
    if (src[n] != null && src[n] !== '') return src[n]
  }
  return undefined
}

/** Положительное целое из числа или строки; иначе `undefined`. */
function readId(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** Непустая строка с обрезкой; иначе `undefined`. */
function readText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const v = raw.trim()
  return v.length > 0 ? v : undefined
}

export function readWidgetParams(options: unknown): WidgetParams {
  if (typeof options !== 'object' || options === null) return {}
  const o = options as Record<string, unknown>
  const params: WidgetParams = {}
  const dealId = readId(pick(o, 'ID', 'id', 'dealId', 'DEAL_ID'))
  if (dealId !== undefined) params.dealId = dealId
  const surveyKey = readText(pick(o, 'surveyKey', 'SURVEY_KEY'))
  if (surveyKey !== undefined) params.surveyKey = surveyKey
  const token = readText(pick(o, 'token', 'TOKEN'))
  if (token !== undefined) params.token = token
  return params
}

/** Параметры открытия, в которых приглашение уже выписано: оба поля ссылки на месте. */
export type IssuedInvitation = WidgetParams & { surveyKey: string; token: string }

/**
 * Открыт ли виджет ПО УЖЕ ВЫПИСАННОМУ приглашению.
 *
 * Нужны оба поля: по одному токену не собрать ссылку (в ней есть ключ опроса), а по одному ключу
 * нечего показывать. Половина параметров — это сбой проводки кнопки, и вести себя тогда надо как при
 * обычном открытии (создать ссылку), а не молча показывать пустоту.
 */
export function hasIssuedInvitation(p: WidgetParams): p is IssuedInvitation {
  return p.surveyKey !== undefined && p.token !== undefined
}

/**
 * Собрать `actionParams` кнопки «Отправить приглашение» на деле в таймлайне.
 *
 * Живёт РЯДОМ с разбором намеренно: имена параметров нужны в двух несвязанных местах — тут их пишет
 * дело (`src/bitrix24/activity.ts`), там читает виджет. Разъехавшись, они не сломают ни сборку, ни
 * тесты: кнопка просто откроет виджет без токена, тот примет это за обычное открытие и выпишет ВТОРОЕ
 * приглашение. Одна точка правды делает такое расхождение невозможным.
 */
export function inviteActionParams(p: { dealId: number; surveyKey: string; token: string }): Record<string, string | number> {
  return { dealId: p.dealId, surveyKey: p.surveyKey, token: p.token }
}

/** Вердикт о годности уже выписанной ссылки — что показать сотруднику в виджете. */
export interface LinkVerdict {
  /** Можно отдавать ссылку клиенту. */
  alive: boolean
  /** Текст отказа от сервера — показываем как есть (он уже написан для человека). */
  reason?: string
}

/**
 * Разобрать ответ проверки ссылки (`GET /api/survey/:key/invitation`) в вердикт для виджета.
 *
 * Проверка нужна потому, что кнопка живёт на деле, а дело в таймлайне не исчезает. Сотрудник может
 * открыть **старое** дело и нажать кнопку на ссылке, которая давно израсходована или протухла — и
 * отправить клиенту мёртвую ссылку, не узнав об этом.
 *
 * ⚠️ **Fail-open, и это осознанно.** Мёртвой ссылку объявляем ТОЛЬКО по явному отказу сервера. «Слишком
 * много запросов» (429) и сбой сервера (5xx) — это не вердикт о ссылке, а состояние проверки; посчитав
 * их отказом, мы заставили бы сотрудника выписывать вторую ссылку на живое приглашение, то есть сами
 * породили бы дубль ровно там, где от него защищаемся. Цена ошибки в другую сторону — сотрудник отправит
 * ссылку, которая не откроется, и клиент попросит новую: неприятно, но обратимо.
 */
export function readLinkVerdict(status: number, body: unknown): LinkVerdict {
  const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  if (b['ok'] === true) return { alive: true }
  if (status === 429 || status >= 500) return { alive: true }
  const reason = readText(b['error'])
  return reason !== undefined ? { alive: false, reason } : { alive: false }
}
