import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import {
  DEFAULT_INVITATION_KEEP_DAYS, MAX_INVITATION_KEEP_DAYS,
  PgInvitationStore, hashToken, resolveInvitationKeepDays
} from '../src/store/pg-invitation'
import type { Queryable } from '../src/store/types'
import type { CrmContext } from '../src/domain/schema'
import { applySchema } from './helpers/schema'

/**
 * Durable-стор приглашений (#4) на настоящем Postgres (pglite, WASM — та же схема, что в проде:
 * `applySchema` проигрывает `migrations/*.sql`).
 *
 * ⚠️ Тесты здесь не «на всякий случай». In-memory реализация получала одноразовость даром — от
 * однопоточности Node: между проверкой и пометкой у неё нет точки прерывания. В БД её нет, и
 * check-then-act пропустил бы обе одновременные отправки по одной ссылке, то есть один и тот же
 * человек оценил бы сделку дважды, а второй ответ вытеснил бы первый в аналитике.
 */
let pglite: PGlite
let db: Queryable
beforeAll(async () => {
  pglite = new PGlite()
  await applySchema(pglite)
  db = pglite as unknown as Queryable
})
afterAll(async () => {
  await pglite.close()
})

let portalSeq = 0
async function freshPortal(): Promise<number> {
  const seq = ++portalSeq
  const r = await db.query<{ id: number }>(
    'insert into portal (member_id, domain, tokens) values ($1, $2, $3::jsonb) returning id',
    [`inv-m${seq}`, `inv-p${seq}.b24`, '{}']
  )
  return r.rows[0]!.id
}

const NOW = new Date('2026-08-15T10:00:00.000Z')
const later = (ms: number): Date => new Date(NOW.getTime() + ms)
const ctx: CrmContext = {
  dealId: 5994, dealCategoryId: 1, dealStageId: 'C1:WON', companyId: 3986,
  responsibleId: 11, dealAmount: 120_000, companyName: 'ООО «Ромашка»', responsibleName: 'Иванов Иван'
}
const PIN = { surveyKey: 'csat_postdeal', versionNo: 2 }

async function store(): Promise<PgInvitationStore> {
  return new PgInvitationStore(db, { portalId: await freshPortal() })
}
async function issue(s: PgInvitationStore, over: Partial<{ surveyKey: string; versionNo: number; ttlMs: number; token: string }> = {}) {
  return s.create({ surveyKey: PIN.surveyKey, versionNo: PIN.versionNo, context: ctx, ...over }, NOW)
}

describe('PgInvitationStore: создание и чтение', () => {
  it('созданное приглашение читается по токену со ВСЕМ снимком контекста', async () => {
    const s = await store()
    const inv = await issue(s)
    const found = await s.peek(inv.token, NOW)
    expect(found?.surveyKey).toBe(PIN.surveyKey)
    expect(found?.versionNo).toBe(PIN.versionNo)
    // Снимок обязан вернуться целиком: именно он становится `context` ответа, и потеря любого поля
    // здесь — это молча испорченный срез дашборда, а не «неполные данные».
    expect(found?.context).toEqual(ctx)
    expect(found?.status).toBe('pending')
  })

  it('в БД лежит ХЕШ, а не рабочая ссылка', async () => {
    // Угроза — дамп базы: из него не должны доставаться живые токены.
    const s = await store()
    const inv = await issue(s)
    const r = await db.query<{ token: string | null; token_hash: string | null }>(
      'select token, token_hash from invitation where token_hash = $1', [hashToken(inv.token)]
    )
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]!.token, 'открытый токен уехал в базу').toBeNull()
    expect(r.rows[0]!.token_hash).not.toBe(inv.token)
  })

  it('неизвестный токен → undefined', async () => {
    const s = await store()
    await issue(s)
    expect(await s.peek('нет-такого', NOW)).toBeUndefined()
  })

  it('срок ссылки соблюдается: до истечения — читается, после — нет', async () => {
    const s = await store()
    const inv = await issue(s, { ttlMs: 5 * 60_000 }) // 5 минут — минимум linkTtlSeconds
    expect(await s.peek(inv.token, later(4 * 60_000))).toBeDefined()
    expect(await s.peek(inv.token, later(5 * 60_000 + 1)), 'протухшая ссылка отдала снимок CRM').toBeUndefined()
  })

  it('явный токен ставится как есть — паритет с in-memory (демо-засев)', async () => {
    const s = await store()
    const inv = await issue(s, { token: 'demo-invitation' })
    expect(inv.token).toBe('demo-invitation')
    expect((await s.peek('demo-invitation', NOW))?.context.dealId).toBe(5994)
  })

  it('чужой портал не видит приглашение — tenant-изоляция', async () => {
    // `portalId` задаётся конструктором, как у PgStore: реализация без скоупа молча выпала бы и из
    // удаления данных портала, и из редакции ПДн (#31).
    const a = await store()
    const b = await store()
    const inv = await issue(a)
    expect(await b.peek(inv.token, NOW)).toBeUndefined()
    expect(await b.consume(inv.token, PIN, NOW)).toEqual({ status: 'unknown' })
    // И у владельца ссылка при этом жива — чужая попытка её не сожгла.
    expect((await a.consume(inv.token, PIN, NOW)).status).toBe('ok')
  })
})

describe('PgInvitationStore: расход (одноразовость)', () => {
  it('первый расход отдаёт снимок, второй → replay', async () => {
    const s = await store()
    const inv = await issue(s)
    const first = await s.consume(inv.token, PIN, NOW)
    expect(first.status).toBe('ok')
    expect(first.status === 'ok' && first.invitation.context).toEqual(ctx)
    expect(first.status === 'ok' && first.invitation.status).toBe('used')
    expect(await s.consume(inv.token, PIN, later(1000))).toEqual({ status: 'replay' })
    // И предпросмотр после расхода молчит: снимок израсходованного токена наружу не отдаём.
    expect(await s.peek(inv.token, later(1000))).toBeUndefined()
  })

  it('ДВЕ ОДНОВРЕМЕННЫЕ отправки по одной ссылке → ровно одна проходит', async () => {
    // ⚠️ Главное свойство этой реализации. In-memory получал его от однопоточности Node даром;
    // здесь оно держится на условии `used_at is null` ВНУТРИ одного UPDATE. Разложи это на
    // «прочитать → проверить → пометить», и обе отправки увидели бы живую строку.
    const s = await store()
    const inv = await issue(s)
    const results = await Promise.all([
      s.consume(inv.token, PIN, NOW),
      s.consume(inv.token, PIN, NOW)
    ])
    expect(results.filter((r) => r.status === 'ok'), 'ссылка сработала дважды').toHaveLength(1)
    expect(results.filter((r) => r.status === 'replay')).toHaveLength(1)
  })

  it('чужой пин → mismatch, и токен НЕ сожжён', async () => {
    // Контракт порта: несовпадение опроса/версии не расходует приглашение — иначе утёкший токен
    // гасился бы одним запросом на чужой опрос (анти-DoS).
    const s = await store()
    const inv = await issue(s)
    expect(await s.consume(inv.token, { surveyKey: 'другой', versionNo: 2 }, NOW)).toEqual({ status: 'mismatch' })
    expect(await s.consume(inv.token, { surveyKey: PIN.surveyKey, versionNo: 99 }, NOW)).toEqual({ status: 'mismatch' })
    expect((await s.consume(inv.token, PIN, NOW)).status, 'чужой пин сжёг приглашение').toBe('ok')
  })

  it('протухшая ссылка → unknown, а не replay', async () => {
    // Разница для человека: «срок истёк» и «вы уже прошли» — разные тексты и разные действия.
    const s = await store()
    const inv = await issue(s, { ttlMs: 5 * 60_000 })
    expect(await s.consume(inv.token, PIN, later(6 * 60_000))).toEqual({ status: 'unknown' })
  })

  it('неизвестный токен → unknown', async () => {
    const s = await store()
    expect(await s.consume('нет-такого', PIN, NOW)).toEqual({ status: 'unknown' })
  })
})

describe('PgInvitationStore: чистка по сроку', () => {
  it('сносит мёртвое старше срока, живое не трогает', async () => {
    const s = await store()
    const live = await issue(s)                                  // жива: истечёт через 30 дней
    const used = await issue(s)
    await s.consume(used.token, PIN, NOW)                        // израсходована сегодня
    const day = 24 * 60 * 60_000

    // Через 10 дней при keepDays=30 не подметается ничего: мёртвое ещё «отлёживается».
    expect(await s.sweepExpired(later(10 * day), 30)).toBe(0)
    // Через 40 дней израсходованная уходит, живая остаётся (её срок ещё не настал… но настал бы
    // через 30 дней — поэтому проверяем именно по факту чтения ниже).
    expect(await s.sweepExpired(later(40 * day), 30)).toBe(1)
    expect(await s.peek(live.token, later(10 * day)), 'подмели живую ссылку').toBeDefined()
  })

  it('срок хранения клампится, мусорное значение → дефолт', async () => {
    // Гард от `INVITATION_KEEP_DAYS=0` (снесло бы только что выписанные ссылки) и от `=99999`.
    const s = await store()
    const inv = await issue(s, { ttlMs: 60_000 })
    const day = 24 * 60 * 60_000
    // keepDays=0 клампится до 1 → через 12 часов после смерти ещё рано.
    expect(await s.sweepExpired(later(12 * 60 * 60_000), 0)).toBe(0)
    expect(await s.sweepExpired(later(2 * day), 0), 'клампа нет: 0 дней снесло бы всё мёртвое сразу').toBe(1)
    expect(await s.peek(inv.token, later(2 * day))).toBeUndefined()
  })

  it('чужой портал не подметает наши приглашения', async () => {
    const a = await store()
    const b = await store()
    const inv = await issue(a, { ttlMs: 60_000 })
    const day = 24 * 60 * 60_000
    expect(await b.sweepExpired(later(40 * day), 30), 'подмели чужой портал').toBe(0)
    expect(await a.sweepExpired(later(40 * day), 30)).toBe(1)
    void inv
  })
})

describe('срок хранения из окружения', () => {
  it('дефолт 30 суток; мусор и непозитив деградируют в него', () => {
    // Занижение до нуля снесло бы приглашение ровно в момент истечения — вместе с возможностью
    // отличить «протухла» от «не было такой», то есть с текстом, который читает человек.
    for (const raw of [undefined, '', 'тридцать', '0', '-5', 'NaN', '1e', '  ']) {
      expect(resolveInvitationKeepDays(raw), JSON.stringify(raw)).toBe(DEFAULT_INVITATION_KEEP_DAYS)
    }
  })

  it('нормальные значения проходят, дробь усекается, края клампятся', () => {
    expect(resolveInvitationKeepDays('7')).toBe(7)
    expect(resolveInvitationKeepDays('1.9')).toBe(1)
    expect(resolveInvitationKeepDays('99999')).toBe(MAX_INVITATION_KEEP_DAYS)
  })
})
