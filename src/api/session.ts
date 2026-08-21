import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * SERVER-ONLY (использует `node:crypto`). Сессия дашборда (контур B, #47): к какому порталу
 * Bitrix24 относится открывший дашборд. Токен ПОДПИСЫВАЕТСЯ (HMAC-SHA256), а не шифруется —
 * payload не секрет (tenant-ключ + срок), но его нельзя подделать без серверного секрета.
 * Формат: `base64url(JSON).base64url(HMAC)`.
 *
 * Минтит сессию слой связки Bitrix24 (handshake app-фрейма — следующий слайс #47); здесь —
 * sign/verify + чистое решение гейта (`resolveDashboardAuth`, тестируемо, без env/h3).
 */
export interface PortalSession {
  /** tenant-ключ: `member_id` портала Bitrix24. */
  portalId: string
  /** срок годности, unix-секунды. */
  exp: number
  /**
   * Администратор ли пользователь, открывший фрейм (`profile.ADMIN` на момент handshake).
   * **Необязательное и fail-closed:** отсутствие поля = НЕ администратор. Так старые сессии,
   * выписанные до появления гейта, не дают прав записи, а не наоборот.
   */
  admin?: boolean
}

/** Минимальная длина серверного секрета (слабый/пустой → отказ, а не слабый HMAC). */
export const MIN_SECRET_LEN = 32
/** Sentinel-portalId для dev-открытого режима (не коллидирует с реальным `member_id`). */
export const DEV_PORTAL_ID = '__dev__'

/**
 * Достаточно ли силён серверный секрет для подписи/проверки сессии: задан и длиной ≥ {@link MIN_SECRET_LEN}.
 * Единый предикат для всех точек, решающих fail-closed по секрету (гейт дашборда И минт сессии портала) —
 * чтобы пороги не разъезжались (минтим то, что гейт сможет проверить тем же критерием).
 */
export function isStrongSecret(secret: string | undefined): secret is string {
  return !!secret && secret.length >= MIN_SECRET_LEN
}

const b64url = (buf: Buffer): string => buf.toString('base64url')
const hmacRaw = (payload: string, secret: string): Buffer =>
  createHmac('sha256', secret).update(payload).digest()

/** Подписать сессию: `base64url(JSON).base64url(HMAC-SHA256(payload))`. */
export function signSession(session: PortalSession, secret: string): string {
  const payload = b64url(Buffer.from(JSON.stringify(session)))
  return `${payload}.${b64url(hmacRaw(payload, secret))}`
}

/**
 * Проверить и распарсить токен → сессия или `null` (подделка/просрочка/мусор/чужой/пустой секрет).
 * Сравнение подписи — constant-time над СЫРЫМИ байтами HMAC. `now` — для тестов (unix-секунды).
 */
export function verifySession(
  token: unknown,
  secret: string,
  now: number = Math.floor(Date.now() / 1000)
): PortalSession | null {
  if (typeof token !== 'string' || !secret) return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const payload = token.slice(0, dot)
  const sig = Buffer.from(token.slice(dot + 1), 'base64url')
  const expected = hmacRaw(payload, secret)
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString())
  } catch {
    return null
  }
  if (!isPortalSession(parsed) || parsed.exp <= now) return null
  return parsed
}

function isPortalSession(v: unknown): v is PortalSession {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Record<string, unknown>
  return (
    typeof s.portalId === 'string' &&
    s.portalId.length > 0 &&
    typeof s.exp === 'number' &&
    Number.isFinite(s.exp)
  )
}

/** Окружение гейта (без env/h3 — чистые значения для тестируемости). */
export interface DashboardAuthEnv {
  secret?: string
  devOpen: boolean
  isProduction: boolean
}
export type DashboardAuthDecision =
  | { ok: true; session: PortalSession }
  | { ok: false; status: 401 | 503 }

/**
 * Чистое решение гейта ЗАПИСИ конфигурации опросов: пускать ли эту сессию менять опросы.
 *
 * Отдельно от `resolveDashboardAuth`, потому что вопросы разные: та отвечает «какой это портал»,
 * эта — «можно ли этому человеку менять то, что увидит клиент заказчика». ЧИТАТЬ дашборд может любой
 * сотрудник портала, ПУБЛИКОВАТЬ — только администратор.
 *
 * Живёт в ядре, а не в h3-слое, намеренно: это единственная строка, ради которой существует гейт, и
 * оставлять её вне тестов нельзя (`server/**
 * Единый текст отказа гейта записи. Живёт в ядре, а не рядом с h3-гейтом, по той же причине, что и
 * само решение: `server/**
 * Текст отказа гейта ЧТЕНИЯ (дашборд) по статусу.
 *
 * Живёт в ядре, а не в роуте, по той же причине, что и `ADMIN_REQUIRED_MESSAGE`: `server/**` тестами
 * не покрывается, а визуальный гейт до этих веток не достаёт — он поднимает сервер с
 * `DASHBOARD_DEV_OPEN=1`, где отказа не бывает. То есть без этой функции можно было бы поменять две
 * строки местами (401 отдавать «обратитесь к администратору», 503 — «сессия истекла») и не уронить
 * ничего, хотя это и есть всё видимое поведение отказа.
 *
 * ⚠️ 503 намеренно НЕ называет переменную окружения. Гейт срабатывает раньше проверки ключа опроса,
 * поэтому `/d/что-угодно` открыт любому из интернета: точный доклад «задайте DASHBOARD_AUTH_SECRET»
 * рассказал бы неизвестному, что авторизация дашборда сейчас не работает. Имя переменной админ
 * получит там, где оно ему нужно, — в логе запуска и в `pnpm env:check`.
 */
/**
 * Отказ «портал больше не обслуживается этим приложением» (#47/#49).
 *
 * ⚠️ Отдельный текст, а не `dashboardAuthMessage(401)`, по двум причинам, и обе видны человеку.
 * Во-первых, тот обещает «дашборд откроется снова» — а сюда приходят и из КОНСТРУКТОРА опросов, где
 * дашборда нет вовсе. Во-вторых, его совет («закройте и откройте приложение заново») на этой ветке
 * невыполним: сессия жива, а строки портала уже нет — приложение удалили, и повторное открытие
 * фрейма ничего не изменит. Совет, который не сработает, хуже отсутствующего.
 */
export const PORTAL_GONE_MESSAGE =
  'Приложение больше не установлено на этом портале. Если это ошибка, попросите администратора '
  + 'портала установить его заново — данные и настройки вернутся вместе с ним.'

export function dashboardAuthMessage(status: 401 | 503): string {
  return status === 401
    ? 'Сессия портала истекла. Закройте и заново откройте приложение из Bitrix24 — дашборд откроется снова.'
    : 'Дашборд временно недоступен. Обратитесь к администратору приложения.'
}

/**` тестами не покрывается, а длина этой строки — не косметика. Её показывает
 * `serverMessage`, у которой есть предел (`MAX_SERVER_MESSAGE`), и текст уже занимает 288 символов из
 * 300 — ещё одно предложение, и самое важное сообщение проекта молча схлопнулось бы в общий фолбэк.
 * Из ядра предел проверяется тестом.
 *
 * По правилу проекта в сообщении видно ГДЕ, ЧТО и ЧТО ДАЛЬШЕ — плюс главное для человека, который
 * только что жал «Опубликовать»: его правки не пропали.
 */
export const ADMIN_REQUIRED_MESSAGE =
  'Публикация опроса: публиковать новые версии может только администратор портала Bitrix24. '
  + 'Ваши правки не потеряны — они остались в конструкторе. Попросите администратора опубликовать опрос. '
  + 'Если права администратора вам только что выдали, закройте и заново откройте приложение из Bitrix24.'

/**` в этом проекте тестами не покрывается).
 *
 * Fail-closed: пускаем ТОЛЬКО при `admin === true`. Отсутствие поля (сессия выписана до появления
 * гейта) и любое иное значение — отказ. Сессия подписана нашим же секретом, но тип поля в ней не
 * валидируется, поэтому строгое сравнение здесь — не перестраховка, а сама проверка.
 */
export function resolveWriteAccess(session: PortalSession): { ok: true } | { ok: false; status: 403 } {
  return session.admin === true ? { ok: true } : { ok: false, status: 403 }
}

/**
 * Чистое решение гейта дашборда (#47), fail-closed. Политика:
 *  - секрет валидной длины → нужна валидная сессия из `token`, иначе **401**;
 *  - секрет задан, но слабый/короткий (< {@link MIN_SECRET_LEN}) → **503** (не используем слабый HMAC);
 *  - без секрета и (`devOpen` ИЛИ не production) → dev-сессия (`DEV_PORTAL_ID`);
 *  - без секрета в production без `devOpen` → **503** (не отдаём PII без конфигурации auth).
 * Секрет имеет ПРИОРИТЕТ над `devOpen`: при заданном секрете dev-открытость не действует.
 */
export function resolveDashboardAuth(
  env: DashboardAuthEnv,
  token: unknown,
  now: number = Math.floor(Date.now() / 1000)
): DashboardAuthDecision {
  if (env.secret) {
    if (!isStrongSecret(env.secret)) return { ok: false, status: 503 }
    const session = verifySession(token, env.secret, now)
    return session ? { ok: true, session } : { ok: false, status: 401 }
  }
  if (env.devOpen || !env.isProduction) {
    // Dev-открытый режим = авторизации нет вообще. Роль тоже открываем — иначе конструктор опросов
    // нельзя было бы гонять локально. НО только вне production: иначе прод, забытый с
    // `DASHBOARD_DEV_OPEN=1`, отдавал бы анониму не только чтение PII (уже плохо), но и ПУБЛИКАЦИЮ
    // опросов — то есть возможность подменить текст, который увидит клиент заказчика.
    return { ok: true, session: { portalId: DEV_PORTAL_ID, exp: now + 3600, admin: !env.isProduction } }
  }
  return { ok: false, status: 503 }
}
