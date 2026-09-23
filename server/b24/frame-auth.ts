/**
 * Proves that a request from the app's iframe really comes from the portal it claims,
 * and that the person behind it may touch the entity they ask about.
 *
 * Страница приложения живёт в iframe портала и знает `member_id` и фреймовый токен (`AUTH_ID`).
 * Написать их в запрос может кто угодно — значит проверять обязан сервер, и единственный, кто
 * может подтвердить токен, это сам портал.
 *
 * ⚠ Адрес портала берётся из НАШЕЙ записи по `member_id`, а не из запроса. Иначе проверка
 * превращается в SSRF: подставив свой адрес, обращающийся получил бы «подтверждение» от
 * собственного сервера. Обращающийся сообщает только `member_id`; куда за проверкой идти —
 * решаем мы.
 */

/** Сколько ждём портал. Тот же приём и та же причина, что в `oauth.ts`: не висеть вечно. */
const VERIFY_TIMEOUT_MS = 10_000

/**
 * Метод проверки личности.
 *
 * ⚠ `profile`, а НЕ `user.current`, и это не вкусовщина. Сначала здесь стоял `user.current`
 * с комментарием «требует лишь базового скоупа» — неправда, документация метода даёт ему
 * `user, user_brief, user_basic`, а такого скоупа приложение не запрашивает вовсе
 * (`crm, im, imbot, pull, bizproc, placement`). То есть проверка на живом портале скорее всего
 * просто не работала бы. У `profile` скоуп именно базовый, доступный любому приложению.
 * Нашла панель ревью PR #18.
 */
const VERIFY_METHOD = 'profile'

export type FrameCheck
  = | { ok: true, userId: number, userName: string }
    | { ok: false, reason: 'rejected' | 'unreachable' }

/** Виден ли сотруднику элемент CRM — спрошено ЕГО токеном, а не нашим. */
export type EntityCheck
  = | { ok: true }
    | { ok: false, reason: 'denied' | 'unreachable' }

/**
 * Спросить портал, настоящий ли это фреймовый токен.
 *
 * Отказ портала (`401`, `expired_token`) и недоступность портала — разные вещи, и наружу они
 * уходят по-разному: первое означает «не пущу», второе — «попробуйте позже». Свалить их в одно
 * значило бы объявлять сотрудника самозванцем каждый раз, когда у портала плохой день.
 */
export async function verifyFrameToken(
  domain: string,
  authId: string,
  fetchFn: typeof fetch = fetch,
): Promise<FrameCheck> {
  const response = await callAsUser(domain, authId, VERIFY_METHOD, {}, fetchFn)
  if (!response.ok) return { ok: false, reason: response.reason }

  const profile = (response.body as { result?: Record<string, unknown> } | null)?.result
  const userId = Number(profile?.ID)
  if (!Number.isInteger(userId) || userId <= 0) return { ok: false, reason: 'rejected' }
  // ⚠ Имя берётся ЗДЕСЬ и даром. Респондент должен видеть, кто его спрашивает, а узнать
  // имя сотрудника иначе нечем: скоупа `user`/`user_brief` приложение не запрашивает
  // (`crm, im, imbot, pull, bizproc, placement`), то есть `user.get` ему недоступен.
  // `profile` базовый, и `NAME`/`LAST_NAME` он отдаёт вместе с `ID` — одним вызовом,
  // который мы и так делаем на каждый запрос из фрейма.
  return { ok: true, userId, userName: fullName(profile?.NAME, profile?.LAST_NAME) }
}

/** «Имя Фамилия» из того, что прислал портал. Пусто — у сотрудника не заполнено. */
function fullName(name: unknown, lastName: unknown): string {
  return [name, lastName]
    .map(part => (typeof part === 'string' ? part.trim() : ''))
    .filter(part => part !== '')
    .join(' ')
}

/**
 * Убедиться, что сотрудник действительно видит эту сделку.
 *
 * ⚠ Спрашиваем ТОКЕНОМ СОТРУДНИКА, а не своим. В этом весь смысл: элемент опроса мы создаём
 * токеном приложения, у которого прав больше, чем у любого отдельного сотрудника. Без этой
 * проверки приложение становится подставным лицом — менеджер подставляет в запрос номер чужой
 * сделки, до которой в самом Битрикс24 доступа не имеет, и получает на неё рабочую ссылку.
 * Идентификатор сделки приходит из параметров фрейма, а они подменяются тривиально.
 * Нашла панель ревью PR #18.
 *
 * Токен сотрудника используется ровно здесь и нигде не сохраняется: он живёт час
 * и принадлежит человеку, а не приложению.
 */
export async function verifyDealAccess(
  domain: string,
  authId: string,
  dealId: number,
  fetchFn: typeof fetch = fetch,
): Promise<EntityCheck> {
  const response = await callAsUser(domain, authId, 'crm.deal.get', { id: dealId }, fetchFn)
  if (!response.ok) {
    // Отказ портала здесь означает именно «не видит»: токен мы уже проверили выше,
    // и другой причины для 4xx на чтение своей же сделки нет.
    return { ok: false, reason: response.reason === 'unreachable' ? 'unreachable' : 'denied' }
  }

  const id = Number((response.body as { result?: { ID?: unknown } } | null)?.result?.ID)
  return Number.isInteger(id) && id > 0 ? { ok: true } : { ok: false, reason: 'denied' }
}

type UserCall
  = | { ok: true, body: unknown }
    | { ok: false, reason: 'rejected' | 'unreachable' }

/** Вызов портала токеном сотрудника. Токен уходит ТЕЛОМ: адреса оседают в журналах прокси. */
async function callAsUser(
  domain: string,
  authId: string,
  method: string,
  params: Record<string, unknown>,
  fetchFn: typeof fetch,
): Promise<UserCall> {
  if (domain.trim() === '' || authId.trim() === '') return { ok: false, reason: 'rejected' }

  let response: Response
  try {
    response = await fetchFn(`https://${domain}/rest/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, auth: authId }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    })
  }
  catch {
    return { ok: false, reason: 'unreachable' }
  }

  if (!response.ok) {
    // 4xx — портал сказал «нет». 5xx — порталу плохо, и это не повод не пускать сотрудника
    // навсегда: вызывающий отличит одно от другого по причине.
    return { ok: false, reason: response.status >= 500 ? 'unreachable' : 'rejected' }
  }

  const body = await response.json().catch(() => null) as unknown
  return { ok: true, body }
}
