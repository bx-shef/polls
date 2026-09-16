/**
 * Proves that a request from the app's iframe really comes from the portal it claims.
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
 * Метод проверки.
 *
 * `user.current` выбран не случайно: он требует лишь базового скоупа, не меняет ничего
 * и заодно отвечает, КТО пришёл. Знать это полезно — приглашение выпускает конкретный сотрудник,
 * и в отчёте о ссылках это отдельная колонка.
 */
const VERIFY_METHOD = 'user.current'

export type FrameCheck
  = | { ok: true, userId: number, isAdmin: boolean }
    | { ok: false, reason: 'rejected' | 'unreachable' }

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
  if (domain.trim() === '' || authId.trim() === '') return { ok: false, reason: 'rejected' }

  let response: Response
  try {
    response = await fetchFn(`https://${domain}/rest/${VERIFY_METHOD}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      // Токен уходит ТЕЛОМ, а не в адресе: адреса оседают в журналах прокси целиком.
      body: new URLSearchParams({ auth: authId }).toString(),
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

  const body = await response.json().catch(() => null) as { result?: { ID?: unknown, ADMIN?: unknown } } | null
  const userId = Number(body?.result?.ID)
  if (!Number.isInteger(userId) || userId <= 0) return { ok: false, reason: 'rejected' }

  // Портал отдаёт признак администратора булевым; чужие формы не угадываем — всё, что
  // не явное `true`, считаем «не администратор».
  return { ok: true, userId, isAdmin: body?.result?.ADMIN === true }
}
