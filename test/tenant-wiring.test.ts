import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { DEV_PORTAL_ID, type PortalSession } from '../src/api/session'
import { draftV2, SURVEY_KEY } from '../src/demo/seed'

/**
 * Мультитенант (#47/#49) — ИСПОЛНЯЕМЫЙ гард на настоящей проводке Nitro.
 *
 * ⚠️ Проверяется ровно то, чего до сих пор не было: портал — ПАРАМЕТР запроса, а не состояние
 * процесса. Пока портал выбирался на процесс, каждый отдельный кусок выглядел рабочим — и именно
 * поэтому дефект был бы невидим: клиент одного заказчика заполнял бы анкету другого, ответ ложился
 * бы в чужие данные, а дашборд показывал бы чужие срезы с именами клиентов. Ни одного отказа,
 * ни одной строки в логе.
 *
 * Мокается один модуль — драйвер `pg`: вместо сокета к Postgres пул ходит в pglite. Всё остальное —
 * настоящие `server/utils/api.ts` и `server/utils/tenant.ts`: миграции, `PgStore`, резолверы.
 */
const pglite = new PGlite()
class FakePool {
  constructor(_o: unknown) {}
  on(): void {}
  async query(sql: string, params?: unknown[]) {
    if (params === undefined) { const r = await pglite.exec(sql); return r[r.length - 1] ?? { rows: [] } }
    return pglite.query(sql, params)
  }
  connect() { return Promise.resolve({ query: (s: string, p?: unknown[]) => pglite.query(s, p), release: () => {} }) }
}
vi.mock('pg', () => ({ default: { Pool: FakePool }, Pool: FakePool }))

/** Два портала-арендатора: `m-a` и `m-b`. Оба публикуют опрос с ОДНИМ И ТЕМ ЖЕ ключом. */
let portalA = 0
let portalB = 0

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgres://fake/fake'
  const { applySchema } = await import('./helpers/schema')
  await applySchema(pglite)
  const { PgStore } = await import('../src/store/pg')
  for (const member of ['m-a', 'm-b']) {
    const r = await pglite.query<{ id: number }>(
      `insert into portal (member_id, domain, tokens) values ($1, $2, '{}'::jsonb) returning id`,
      [member, `${member}.bitrix24.ru`]
    )
    const id = r.rows[0]!.id
    if (member === 'm-a') portalA = id; else portalB = id
    await new PgStore(pglite as never, { portalId: id }).publish(draftV2(), 2)
  }
})
afterAll(async () => { delete process.env.DATABASE_URL; await pglite.close() })

const session = (portalId: string): PortalSession => ({ portalId, exp: 2 ** 31, admin: true })

describe('публичный запрос: портал по токену приглашения', () => {
  it('токен выбирает СВОЙ портал, хотя ключ опроса общий', async () => {
    const { invitationsFor } = await import('../server/utils/api')
    const { resolvePublicPortal } = await import('../server/utils/tenant')
    const inv = await (await invitationsFor(portalB)).create(
      { surveyKey: SURVEY_KEY, versionNo: 2, context: { dealId: 7 } }, new Date()
    )
    expect(await resolvePublicPortal(SURVEY_KEY, inv.token, '10.0.0.1')).toEqual({ ok: true, portalId: portalB })
  }, 60_000)

  it('без токена ОБЩИЙ ключ обслужить нельзя — отказ, а не «первый попавшийся»', async () => {
    const { resolvePublicPortal } = await import('../server/utils/tenant')
    expect(await resolvePublicPortal(SURVEY_KEY, undefined, '10.0.0.2'))
      .toEqual({ ok: false, reason: 'ambiguous', deadToken: false })
  }, 60_000)

  it('токен прислан, но мёртв → это ВИДНО вызывающему (deadToken)', async () => {
    const { resolvePublicPortal } = await import('../server/utils/tenant')
    // ⚠️ Признак несущий: роут проверки ссылки по нему обслуживает запрос фолбэк-стором и отдаёт
    // ОБЫЧНЫЙ вердикт ядра («срок истёк или опрос уже пройден»). Без него человек, открывший ровно ту
    // ссылку, о которой ему говорят, получал бы совет открыть её ещё раз, а наружу утекал бы бит
    // «такого токена не существует».
    expect(await resolvePublicPortal(SURVEY_KEY, 'нет-такого-токена', '10.0.0.3'))
      .toEqual({ ok: false, reason: 'ambiguous', deadToken: true })
    // Ключа нет ни у кого → портала нет, дальше отвечает обычный путь (404 «опрос не найден»).
    expect(await resolvePublicPortal('нет-такого-опроса', 'нет-такого-токена', '10.0.0.4'))
      .toEqual({ ok: true, portalId: undefined })
  }, 60_000)

  it('портал резолвится и по ПОГАШЕННОМУ приглашению', async () => {
    // «Улучшение» запроса (`and used_at is null`) выглядит безобидно и деградирует внятный вердикт
    // «опрос уже пройден» до отказа по неоднозначности.
    const { invitationsFor } = await import('../server/utils/api')
    const { resolvePublicPortal } = await import('../server/utils/tenant')
    const invitations = await invitationsFor(portalB)
    const inv = await invitations.create(
      { surveyKey: SURVEY_KEY, versionNo: 2, context: { dealId: 11 } }, new Date()
    )
    await invitations.consume(inv.token, { surveyKey: SURVEY_KEY, versionNo: 2 }, new Date())
    expect(await resolvePublicPortal(SURVEY_KEY, inv.token, '10.0.0.5')).toEqual({ ok: true, portalId: portalB })
  }, 60_000)

  it('бюджет резолва тратится ДО обращения к базе (429, а не работа)', async () => {
    // Лимитер ядра живёт внутри `api.submit`/`api.survey`, то есть ПОЗЖЕ резолва: без своего бюджета
    // каждый анонимный запрос покупал бы себе обращение к общему пулу до всякой защиты.
    const { sharedLimiter } = await import('../server/utils/api')
    const { resolvePublicPortal } = await import('../server/utils/tenant')
    const ip = '10.9.9.9'
    const now = new Date()
    while (sharedLimiter().allow(`t:${ip}`, now)) { /* выбираем бюджет этого адреса */ }
    expect(await resolvePublicPortal(SURVEY_KEY, undefined, ip))
      .toEqual({ ok: false, reason: 'rate', deadToken: false })
  }, 60_000)

  it('две группы ОДНОГО портала с одним ключом — не неоднозначность', async () => {
    // Уникальность в схеме — `(group_id, survey_key)`, то есть портал вправе завести ключ дважды.
    // Без `distinct` он сам себе ломал бы публичные ссылки, и виноватым выглядел бы сосед.
    const { PgStore } = await import('../src/store/pg')
    const { resolvePublicPortal } = await import('../server/utils/tenant')
    for (const groupTitle of ['default', 'вторая группа']) {
      await new PgStore(pglite as never, { portalId: portalA, groupTitle })
        .publish({ ...draftV2(), surveyKey: 'два_раза' }, 2)
    }
    expect(await resolvePublicPortal('два_раза', undefined, '10.0.0.6')).toEqual({ ok: true, portalId: portalA })
  }, 60_000)

})

describe('стор и приглашения скоуплены порталом', () => {
  it('ответ, записанный за портал A, не виден порталу B', async () => {
    const { storeFor, useApiFor } = await import('../server/utils/api')
    const apiA = await useApiFor(portalA)
    const nonce = (await apiA.session({ ip: '10.0.0.1' })).body.nonce as string
    const r = await apiA.submit({
      ip: '10.0.0.1',
      body: {
        schema_version: 1, nonce, surveyKey: SURVEY_KEY, versionNo: 2,
        answers: { q_nps: { values: ['n9'] }, q_csat: { values: ['s4'] }, q_liked: { values: ['speed'] } }
      }
    })
    expect(r.status, JSON.stringify(r.body)).toBe(200)

    expect((await (await storeFor(portalA)).listResponses(SURVEY_KEY)).length).toBe(1)
    expect(
      (await (await storeFor(portalB)).listResponses(SURVEY_KEY)).length,
      'ответ портала A виден порталу B — tenant-изоляции нет'
    ).toBe(0)
  }, 60_000)

  it('приглашение портала B не резолвится стором портала A', async () => {
    const { invitationsFor } = await import('../server/utils/api')
    const inv = await (await invitationsFor(portalB)).create(
      { surveyKey: SURVEY_KEY, versionNo: 2, context: { dealId: 8 } }, new Date()
    )
    expect(await (await invitationsFor(portalB)).peek(inv.token, new Date())).toBeDefined()
    expect(
      await (await invitationsFor(portalA)).peek(inv.token, new Date()),
      'чужое приглашение видно из другого портала'
    ).toBeUndefined()
  }, 60_000)
})

describe('процессные синглтоны переживают выбор портала', () => {
  it('nonce из /api/session принимает сабмит ЛЮБОГО портала', async () => {
    // ⚠️ Несущее и неочевидное: `/api/session` минтит nonce через `useApi()` (портал ему не нужен),
    // а `/api/submit` расходует его через `useApiFor(portalId)` — это РАЗНЫЕ экземпляры `Api`. Держит
    // связь одна строка `nonces: sharedNonces()`; убери её — и `createApi` заведёт каждому свой стор,
    // после чего КАЖДЫЙ живой сабмит вернёт 403 «страница устарела» при зелёном наборе тестов.
    const { useApi, useApiFor } = await import('../server/utils/api')
    const nonce = (await (await useApi()).session({ ip: '10.0.1.1' })).body.nonce as string
    const r = await (await useApiFor(portalA)).submit({
      ip: '10.0.1.1',
      body: {
        schema_version: 1, nonce, surveyKey: SURVEY_KEY, versionNo: 2,
        answers: { q_nps: { values: ['n9'] }, q_csat: { values: ['s4'] }, q_liked: { values: ['speed'] } }
      }
    })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
  }, 60_000)

  it('resetStoreCache сбрасывает и ПЕР-ПОРТАЛЬНЫЕ кэши', async () => {
    // Удаление приложения сносит РОВНО ту строку, на числовой id которой прибиты закэшированные
    // `PgStore`/`PgInvitationStore`. Оставленный кэш означает, что каждая следующая запись упирается
    // в FK — и тихо: install-страница рисует «установлено», `/api/health` зелёный.
    const { storeFor, invitationsFor, useApiFor, resetStoreCache } = await import('../server/utils/api')
    const before = {
      store: await storeFor(portalA),
      invitations: await invitationsFor(portalA),
      api: await useApiFor(portalA)
    }
    resetStoreCache()
    expect(await storeFor(portalA)).not.toBe(before.store)
    expect(await invitationsFor(portalA)).not.toBe(before.invitations)
    expect(await useApiFor(portalA)).not.toBe(before.api)
  }, 60_000)
})

describe('запрос из фрейма: портал по member_id сессии (#47)', () => {
  it('сессия портала B → числовой id портала B', async () => {
    const { resolveSessionPortal } = await import('../server/utils/tenant')
    expect(await resolveSessionPortal(session('m-b'))).toEqual({ ok: true, portalId: portalB })
  }, 60_000)

  it('портала с таким member_id больше нет → 401, а НЕ общий стор', async () => {
    // Подпись доказывает, чей это портал, но не то, что он ещё установлен. Фолбэк на общий стор в
    // этот момент показал бы сотруднику удалённого заказчика данные чужого портала.
    const { resolveSessionPortal } = await import('../server/utils/tenant')
    expect(await resolveSessionPortal(session('m-удалён'))).toEqual({ ok: false, status: 401 })
  }, 60_000)

  it('dev-открытый режим (авторизации нет) → портал не выбирается, общий стор', async () => {
    const { resolveSessionPortal } = await import('../server/utils/tenant')
    expect(await resolveSessionPortal(session(DEV_PORTAL_ID))).toEqual({ ok: true, portalId: undefined })
  }, 60_000)
})

describe('событийный путь: тенант по member_id', () => {
  it('стор и приглашения приходят от СВОЕГО портала', async () => {
    const { tenantByMemberId } = await import('../server/utils/tenant')
    const { invitationsFor } = await import('../server/utils/api')
    const t = await tenantByMemberId('m-b')
    expect(t).toBeDefined()
    const inv = await t!.invitations.create(
      { surveyKey: SURVEY_KEY, versionNo: 2, context: { dealId: 9 } }, new Date()
    )
    expect(await (await invitationsFor(portalB)).peek(inv.token, new Date())).toBeDefined()
    expect(await (await invitationsFor(portalA)).peek(inv.token, new Date())).toBeUndefined()
  }, 60_000)

  it('портала нет → undefined (триггерить некуда)', async () => {
    const { tenantByMemberId } = await import('../server/utils/tenant')
    expect(await tenantByMemberId('m-нет')).toBeUndefined()
  }, 60_000)
})
