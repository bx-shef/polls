import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  DEV_PORTAL_ID,
  MIN_SECRET_LEN,
  isStrongSecret,
  resolveDashboardAuth,
  resolveWriteAccess,
  signSession,
  verifySession,
  type PortalSession
} from '../src/api/session'

const SECRET = 'test-secret-abcdefghijklmnopqrstuvwxyz-0123' // ≥ MIN_SECRET_LEN
const future = Math.floor(Date.now() / 1000) + 3600

describe('session — подписанный токен портала (#47)', () => {
  const s: PortalSession = { portalId: 'portal-42', exp: future }

  it('sign → verify round-trip возвращает исходную сессию', () => {
    expect(verifySession(signSession(s, SECRET), SECRET)).toEqual(s)
  })

  it('подделка payload (подмена portalId) отвергается', () => {
    const token = signSession(s, SECRET)
    const forged = Buffer.from(JSON.stringify({ portalId: 'evil', exp: future })).toString('base64url')
    expect(verifySession(`${forged}.${token.slice(token.indexOf('.') + 1)}`, SECRET)).toBeNull()
  })

  it('подделка подписи отвергается', () => {
    const token = signSession(s, SECRET)
    expect(verifySession(`${token.slice(0, token.indexOf('.'))}.AAAA`, SECRET)).toBeNull()
  })

  it('чужой секрет отвергается', () => {
    expect(verifySession(signSession(s, SECRET), 'other-secret-other-secret-other!')).toBeNull()
  })

  it('просрочка: exp <= now отвергается (включая ровно границу)', () => {
    const t = signSession({ portalId: 'p', exp: 1000 }, SECRET)
    expect(verifySession(t, SECRET, 999)).toEqual({ portalId: 'p', exp: 1000 }) // ещё жив
    expect(verifySession(t, SECRET, 1000)).toBeNull() // ровно граница
    expect(verifySession(t, SECRET, 1001)).toBeNull() // просрочен
  })

  it('валидная подпись, но payload не-JSON → null', () => {
    const payload = Buffer.from('not-json').toString('base64url')
    const sig = createHmac('sha256', SECRET).update(payload).digest('base64url')
    expect(verifySession(`${payload}.${sig}`, SECRET)).toBeNull()
  })

  it('exp = Infinity (не конечное) отвергается', () => {
    const payload = Buffer.from(JSON.stringify({ portalId: 'p', exp: Number.POSITIVE_INFINITY })).toString('base64url')
    // JSON.stringify(Infinity) → null, так что payload содержит exp:null → не number → null
    const sig = createHmac('sha256', SECRET).update(payload).digest('base64url')
    expect(verifySession(`${payload}.${sig}`, SECRET)).toBeNull()
  })

  it('мусор/не-строка/без точки/пустой secret/пустой portalId/число — null', () => {
    expect(verifySession('garbage', SECRET)).toBeNull()
    expect(verifySession('', SECRET)).toBeNull()
    expect(verifySession(42 as unknown, SECRET)).toBeNull()
    expect(verifySession('.sig', SECRET)).toBeNull()
    expect(verifySession('payload.', SECRET)).toBeNull()
    expect(verifySession(signSession(s, SECRET), '')).toBeNull() // пустой секрет
    expect(verifySession(signSession({ portalId: '', exp: future }, SECRET), SECRET)).toBeNull()
    const numId = Buffer.from(JSON.stringify({ portalId: 123, exp: future })).toString('base64url')
    const numSig = createHmac('sha256', SECRET).update(numId).digest('base64url')
    expect(verifySession(`${numId}.${numSig}`, SECRET)).toBeNull() // portalId не строка
  })
})

describe('isStrongSecret — общий предикат силы секрета (#47/#49)', () => {
  it('задан и ≥ MIN_SECRET_LEN → true', () => {
    expect(isStrongSecret(SECRET)).toBe(true)
    expect(isStrongSecret('a'.repeat(MIN_SECRET_LEN))).toBe(true)
  })
  it('пустой/undefined/короче порога → false (fail-closed)', () => {
    expect(isStrongSecret(undefined)).toBe(false)
    expect(isStrongSecret('')).toBe(false)
    expect(isStrongSecret('a'.repeat(MIN_SECRET_LEN - 1))).toBe(false)
  })
})

describe('resolveDashboardAuth — гейт дашборда (#47)', () => {
  const valid = signSession({ portalId: 'p1', exp: future }, SECRET)

  it('секрет + валидная сессия → ok', () => {
    const d = resolveDashboardAuth({ secret: SECRET, devOpen: false, isProduction: true }, valid)
    expect(d).toEqual({ ok: true, session: { portalId: 'p1', exp: future } })
  })

  it('секрет + нет/битый токен → 401', () => {
    expect(resolveDashboardAuth({ secret: SECRET, devOpen: false, isProduction: true }, undefined)).toEqual({ ok: false, status: 401 })
    expect(resolveDashboardAuth({ secret: SECRET, devOpen: true, isProduction: true }, 'garbage')).toEqual({ ok: false, status: 401 })
  })

  it('секрет имеет приоритет над devOpen (всё равно требует сессию)', () => {
    expect(resolveDashboardAuth({ secret: SECRET, devOpen: true, isProduction: false }, undefined)).toEqual({ ok: false, status: 401 })
  })

  it('слабый/короткий секрет → 503 (не используем слабый HMAC)', () => {
    expect('short'.length).toBeLessThan(MIN_SECRET_LEN)
    expect(resolveDashboardAuth({ secret: 'short', devOpen: false, isProduction: false }, valid)).toEqual({ ok: false, status: 503 })
  })

  it('без секрета + devOpen → dev-сессия', () => {
    const d = resolveDashboardAuth({ devOpen: true, isProduction: true }, undefined, 1000)
    expect(d).toEqual({ ok: true, session: { portalId: DEV_PORTAL_ID, exp: 1000 + 3600, admin: false } })
  })

  it('вне production dev-сессия получает роль админа (иначе конструктор не погонять локально)', () => {
    const d = resolveDashboardAuth({ devOpen: false, isProduction: false }, undefined, 1000)
    expect(d).toEqual({ ok: true, session: { portalId: DEV_PORTAL_ID, exp: 1000 + 3600, admin: true } })
  })

  it('в PRODUCTION dev-open НЕ выдаёт роль администратора (прод, забытый с флагом, не даст публиковать)', () => {
    // Иначе прод без секрета, но с DASHBOARD_DEV_OPEN=1 отдавал бы анониму не только чтение PII,
    // но и публикацию — возможность подменить текст, который увидит клиент заказчика.
    const d = resolveDashboardAuth({ devOpen: true, isProduction: true }, undefined, 1000)
    expect(d.ok && d.session.admin).toBe(false)
  })

  it('старая сессия БЕЗ поля admin верифицируется, но администратором НЕ считается (fail-closed)', () => {
    // Сессии, выписанные до появления гейта роли, не должны давать прав записи.
    const legacy = signSession({ portalId: 'p-1', exp: 5000 } as PortalSession, SECRET)
    const session = verifySession(legacy, SECRET, 1000)
    expect(session?.portalId).toBe('p-1')
    expect(session?.admin).toBeUndefined() // `admin !== true` → requireAdminSession ответит 403
  })

  it('без секрета + не production → dev-сессия', () => {
    expect(resolveDashboardAuth({ devOpen: false, isProduction: false }, undefined).ok).toBe(true)
  })

  it('без секрета + production без devOpen → 503 (fail-closed)', () => {
    expect(resolveDashboardAuth({ devOpen: false, isProduction: true }, undefined)).toEqual({ ok: false, status: 503 })
  })
})

describe('resolveWriteAccess — гейт записи конфигурации опросов (#139)', () => {
  // Единственная строка, ради которой существует весь гейт: в h3-слое она была бы вне тестов.
  const s = (admin?: unknown): PortalSession => ({ portalId: 'p', exp: future, admin } as PortalSession)

  it('администратор → пускаем', () => {
    expect(resolveWriteAccess(s(true))).toEqual({ ok: true })
  })

  it('не администратор → 403', () => {
    expect(resolveWriteAccess(s(false))).toEqual({ ok: false, status: 403 })
  })

  it('поля нет (сессия выписана до появления гейта) → 403, а не «раз не сказано — значит можно»', () => {
    expect(resolveWriteAccess({ portalId: 'p', exp: future })).toEqual({ ok: false, status: 403 })
  })

  it('значение в чужой форме → 403 (сессия подписана нами, но ТИП поля в ней не валидируется)', () => {
    for (const v of ['true', 'Y', 1, {}, [], 'admin']) {
      expect(resolveWriteAccess(s(v))).toEqual({ ok: false, status: 403 })
    }
  })
})
