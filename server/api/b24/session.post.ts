// POST /api/b24/session — handshake app-фрейма Bitrix24 (#47): недоверенный POST `BX24.getAuth`
// → авторитетная проверка (домен SSRF-allowlist → app.info → сверка member_id, всё в ядре) →
// подписанная сессия портала в cookie `polls_portal` (её читает `requirePortalSession` дашборда).
//
// Тонкая h3-обёртка: парс/проверка/минт — в `~core/bitrix24` (под юнит-тестами без живого портала),
// здесь только маппинг event→ядро→статус/cookie. Fail-closed: без `DASHBOARD_AUTH_SECRET` → 503;
// любая неудача проверки (чужой домен/мёртвый токен/cross-tenant/портал не установлен) → 401 без
// утечки причины. Body мал (несколько полей формы) — cap ЖЁСТЧЕ submit (8КБ vs 64КБ).
import { parseFrameAuth, verifyFrameAuth, mintPortalSession, DEFAULT_SESSION_TTL_SEC } from '~core/bitrix24/frame'
import { resolveB24Secret, useB24Authenticator } from '../../utils/b24-session'

const MAX_BODY_BYTES = 8 * 1024
const SESSION_COOKIE = 'polls_portal'

export default defineEventHandler(async (event) => {
  const len = Number(getRequestHeader(event, 'content-length') ?? 0)
  if (len > MAX_BODY_BYTES) {
    setResponseStatus(event, 413)
    return { ok: false, error: 'Слишком большой запрос' }
  }

  // Секрет минта = секрет верификации дашборда (fail-closed без него).
  const secret = resolveB24Secret()
  if (!secret.ok) {
    setResponseStatus(event, 503)
    return { ok: false, error: 'Сессии портала не сконфигурированы' }
  }

  // h3 парсит form-urlencoded (так POST'ит фрейм) и JSON одинаково.
  const body = await readBody(event)
  const frame = parseFrameAuth(body)
  if (!frame) {
    setResponseStatus(event, 400)
    return { ok: false, error: 'Некорректные параметры авторизации фрейма' }
  }

  try {
    const portal = await verifyFrameAuth(frame, { authenticate: useB24Authenticator() })
    const { token } = mintPortalSession(portal, secret.secret)
    setCookie(event, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: true,
      // Фрейм — сторонний контекст (iframe портала): SameSite=None + Partitioned (CHIPS),
      // иначе браузер не пошлёт cookie на /api/dashboard из iframe. Secure обязателен с None.
      sameSite: 'none',
      partitioned: true,
      path: '/',
      maxAge: DEFAULT_SESSION_TTL_SEC
    })
    return { ok: true }
  } catch {
    // Причину не раскрываем (домен/токен/cross-tenant) — единый 401.
    setResponseStatus(event, 401)
    return { ok: false, error: 'Портал не подтверждён' }
  }
})
