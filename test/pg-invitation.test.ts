import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import {
  DEFAULT_INVITATION_KEEP_DAYS, MAX_INVITATION_KEEP_DAYS,
  PgInvitationStore, hashToken, resolveInvitationKeepDays, sweepAllPortalsInvitations
} from '../src/store/pg-invitation'
import { MemoryInvitationStore, type InvitationStore } from '../src/api/invitation'
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

  it('алгоритм хеша ЗАПИННЕН литералом, а не сверяется сам с собой', () => {
    // ⚠️ Без этой строки все остальные ожидания выражены через саму `hashToken`, то есть подошла бы
    // ЛЮБАЯ хеш-функция: подмена sha256 на md5 проходила весь набор незамеченной. А смена алгоритма
    // — это не рефакторинг: все выписанные ссылки перестают находиться в базе разом.
    expect(hashToken('demo-invitation')).toBe('ceb57d9c0eb61e675051e5b7f9ee20706c47f05ffc6c572dc83cc0c5707f771e')
    expect(hashToken('x'), 'длина не как у sha256').toHaveLength(64)
  })

  it('дубль токена в одном портале отвергается уникальным индексом', async () => {
    // Индекс `uq_invitation_token_hash` — не украшение: без него два приглашения с одним токеном
    // жили бы рядом, и `consume` погасил бы одно, оставив второе с тем же контекстом.
    const s = await store()
    await issue(s, { token: 'дубль' })
    await expect(issue(s, { token: 'дубль' }), 'уникальность хеша не форсится').rejects.toThrow()
    // ⚠️ Ошибка при этом СЫРАЯ, без `on conflict` — и это осознанно до #138: идемпотентность
    // `create` там всё равно проектируется, и глушить конфликт раньше времени значило бы спрятать
    // сигнал о том, что кто-то выписывает приглашения повторно.
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

  it('пустой контекст пишется и читается — денормализованные колонки становятся NULL', async () => {
    // `create` раскладывает поля контекста по колонкам через `?? null`. Ветка «поля нет» — не
    // экзотика: `CrmContext` весь опционален, а виджет ручного запуска шлёт то, что есть у сделки.
    const s = await store()
    const inv = await s.create({ surveyKey: 'k', versionNo: 1, context: {} }, NOW)
    expect((await s.peek(inv.token, NOW))?.context).toEqual({})
    const r = await db.query<Record<string, unknown>>(
      `select deal_id, deal_category_id, deal_stage_id, company_id, contact_id, responsible_id, deal_amount
         from invitation where token_hash = $1`, [hashToken(inv.token)]
    )
    expect(Object.values(r.rows[0]!).every((v) => v === null), 'что-то придумалось из пустого контекста').toBe(true)
  })

  it('денормализованные колонки ЗАПОЛНЯЮТСЯ — по ним построены индексы админских выборок', async () => {
    // Их можно было обнулить все семь, и весь набор оставался зелёным: данные лежали бы в `context`,
    // а выборки, которые ходят по колонкам, их не видели бы. Молчаливое «есть, но невидимо».
    const s = await store()
    const inv = await issue(s)
    const r = await db.query<Record<string, unknown>>(
      `select deal_id, deal_category_id, deal_stage_id, company_id, responsible_id, deal_amount
         from invitation where token_hash = $1`, [hashToken(inv.token)]
    )
    // pglite отдаёт bigint числом, боевой драйвер `pg` — строкой; сверяем по значению, а не по типу.
    expect(Object.fromEntries(Object.entries(r.rows[0]!).map(([k, v]) => [k, String(v)]))).toEqual({
      deal_id: '5994', deal_category_id: '1', deal_stage_id: 'C1:WON',
      company_id: '3986', responsible_id: '11', deal_amount: '120000'
    })
  })

  it('строка, записанная НЕ нами, читается без падения', async () => {
    // Колонки `survey_key`/`version_no`/`context` в схеме nullable (0005 только добавляет, ничего
    // не требует). Значит строку без них может завести кто угодно — старый образ, ручной SQL,
    // будущая миграция. Чтение обязано деградировать, а не бросать: иначе одна кривая строка
    // роняет отправку ответа у всех.
    const portalId = await freshPortal()
    const bare = new PgInvitationStore(db, { portalId })
    await db.query(
      `insert into invitation (portal_id, token_hash, status, sent_at, expires_at)
       values ($1, $2, 'sent', $3, $4)`,
      [portalId, hashToken('голая'), NOW, later(60_000)]
    )
    const found = await bare.peek('голая', NOW)
    expect(found).toEqual({
      token: 'голая',
      surveyKey: '',
      versionNo: 0,
      context: {},
      status: 'pending',
      createdAt: NOW.toISOString(),
      expiresAt: later(60_000).toISOString()
    })
    // И расходу она не поддаётся: пин не сойдётся ни с чем осмысленным.
    expect((await bare.consume('голая', PIN, NOW)).status).toBe('mismatch')
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

describe('PgInvitationStore: данные переживают процесс', () => {
  it('СВЕЖИЙ инстанс стора на том же портале видит ссылку, выписанную прежним', async () => {
    // ⚠️ Ровно то обещание, ради которого затевался переезд, и до ревью его не пиннуло ничего: все
    // тесты работали с ОДНИМ инстансом стора, то есть проверяли БД как хранилище, но не как
    // переживание процесса. Инстанс здесь — самое близкое к «перезапуску», что доступно юниту;
    // полный прогон с убийством процесса делается отдельно, руками, на настоящем PostgreSQL.
    const portalId = await freshPortal()
    const before = new PgInvitationStore(db, { portalId })
    const inv = await before.create({ ...PIN, context: ctx }, NOW)

    const after = new PgInvitationStore(db, { portalId })
    expect(await after.peek(inv.token, NOW), 'ссылка не пережила смену инстанса').toBeDefined()
    const used = await after.consume(inv.token, PIN, NOW)
    expect(used.status).toBe('ok')
    expect(used.status === 'ok' && used.invitation.context).toEqual(ctx)
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
    // «прочитать → проверить → пометить», и обе отправки увидели бы живую строку (мутация проверена
    // — тест падает с «ссылка сработала дважды»).
    //
    // ⚠️ Оговорка про среду: pglite — ОДНО соединение, то есть запросы здесь сериализуются, а
    // настоящей многосоединённой гонки этот тест не воспроизводит. Он ловит именно check-then-act
    // (между чтением и записью есть точка прерывания). Поведение под реальным пулом проверено
    // отдельно, вручную: 5 раундов по 20 параллельных `consume` через пул из 25 соединений на
    // PostgreSQL 16 — каждый раз ровно один `ok` и 19 `replay`.
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

describe('PgInvitationStore: колонки жизненного цикла', () => {
  const lifecycle = async (portalId: number) =>
    (await db.query<{ status: string; completed_at: Date | null; used_at: Date | null; sent_at: Date }>(
      'select status, completed_at, used_at, sent_at from invitation where portal_id = $1', [portalId]
    )).rows[0]!

  it('создание → sent, расход → completed + отметки времени', async () => {
    // На `status` стоит `idx_invitation_portal_status` из 0001, и по нему же читают админские
    // выборки. Приглашение, рождённое сразу «completed», для них было бы невидимо-неправильным.
    const portalId = await freshPortal()
    const s = new PgInvitationStore(db, { portalId })
    const inv = await s.create({ ...PIN, context: ctx }, NOW)
    const born = await lifecycle(portalId)
    expect(born.status).toBe('sent')
    expect(born.used_at).toBeNull()
    expect(born.completed_at).toBeNull()
    expect(new Date(born.sent_at).toISOString()).toBe(NOW.toISOString())

    const at = later(1000)
    await s.consume(inv.token, PIN, at)
    const dead = await lifecycle(portalId)
    expect(dead.status).toBe('completed')
    expect(new Date(dead.used_at!).toISOString()).toBe(at.toISOString())
    expect(new Date(dead.completed_at!).toISOString()).toBe(at.toISOString())
  })

  it('create отдаёт pending и время создания, а не срок', async () => {
    const s = await store()
    const inv = await issue(s, { ttlMs: 60_000 })
    expect(inv.status).toBe('pending')
    expect(inv.createdAt).toBe(NOW.toISOString())
    expect(inv.expiresAt).toBe(later(60_000).toISOString())
  })

  it('границы срока: ровно в момент истечения ссылка уже мертва', async () => {
    // `>` против `>=` — разница в одну миллисекунду и в один симптом: ссылка, живущая «ещё чуть-чуть
    // после срока», ломает обещание `linkTtlSeconds`, а тест на «+1 мс» этого не видит.
    const s = await store()
    const inv = await issue(s, { ttlMs: 60_000 })
    expect(await s.peek(inv.token, later(59_999)), 'до срока — жива').toBeDefined()
    expect(await s.peek(inv.token, later(60_000)), 'ровно в срок — уже мертва').toBeUndefined()
    expect((await s.consume(inv.token, PIN, later(60_000))).status).toBe('unknown')
  })
})

describe('PgInvitationStore: чистка по сроку', () => {
  it('сносит мёртвое старше срока, живое не трогает', async () => {
    const s = await store()
    const live = await issue(s)                                  // истечёт через 30 суток
    const used = await issue(s)
    await s.consume(used.token, PIN, NOW)                        // израсходована сегодня
    const day = 24 * 60 * 60_000

    // Через 10 дней при keepDays=30 не подметается ничего: мёртвое ещё «отлёживается».
    expect(await s.sweepExpired(later(10 * day), 30)).toBe(0)
    // Через 40 дней израсходованная уходит. Живая остаётся: её собственный срок (30 суток от
    // выписки) на 40-й день уже прошёл, но отсчёт хранения идёт от смерти, а не от выписки —
    // поэтому она ещё «отлёживается». Проверяем это чтением, а не счётчиком.
    expect(await s.sweepExpired(later(40 * day), 30)).toBe(1)
    expect(await s.peek(live.token, later(10 * day)), 'подмели живую ссылку').toBeDefined()
  })

  it('срок хранения резолвится ТЕМ ЖЕ правилом, что читает переменную окружения', async () => {
    // ⚠️ Раньше здесь был свой, ДРУГОЙ кламп: `0` внутри метода превращался в 1 день, а
    // `resolveInvitationKeepDays('0')` — в 30. Два разных ответа на один вход у публичного метода и
    // у его единственного вызывающего — расхождение, которое замечают на проде, а не в ревью.
    const s = await store()
    const inv = await issue(s, { ttlMs: 60_000 })
    const day = 24 * 60 * 60_000
    // `0` — мусор, а не «чистить сразу»: деградирует в дефолт 30 суток, как и в env-резолвере.
    expect(await s.sweepExpired(later(2 * day), 0)).toBe(0)
    expect(await s.sweepExpired(later(31 * day), 0)).toBe(1)
    expect(await s.peek(inv.token, later(31 * day))).toBeUndefined()
  })

  it('строка БЕЗ срока не бессмертна — иначе её не видит никто', async () => {
    // Схема 0005 разрешает `expires_at is null` (ослабление старых колонок), наш писатель так не
    // пишет. Без отдельной ветки такая строка вечна: `peek` её не отдаёт, `consume` не расходует,
    // чистка не видит — то есть ПДн лежат, а инструмента убрать их нет.
    const s = await store()
    const portal = await db.query<{ id: number }>(
      `insert into invitation (portal_id, token_hash, survey_key, version_no, status, sent_at, context)
       values ((select id from portal order by id desc limit 1), 'сирота', 'k', 1, 'sent', $1, '{}'::jsonb)
       returning portal_id as id`, [NOW]
    )
    const orphanStore = new PgInvitationStore(db, { portalId: portal.rows[0]!.id })
    const day = 24 * 60 * 60_000
    expect(await orphanStore.sweepExpired(later(2 * day), 30), 'сирота подметена слишком рано').toBe(0)
    expect(await orphanStore.sweepExpired(later(40 * day), 30), 'строка без срока осталась вечной').toBe(1)
    void s
  })

  it('батч ограничен — один DELETE не держит соединение на всём хвосте', async () => {
    const s = await store()
    const day = 24 * 60 * 60_000
    for (let i = 0; i < 5; i++) await issue(s, { ttlMs: 60_000 })
    expect(await s.sweepExpired(later(40 * day), 30, 2), 'кап батча не соблюдён').toBe(2)
    expect(await s.sweepExpired(later(40 * day), 30, 2)).toBe(2)
    expect(await s.sweepExpired(later(40 * day), 30, 2)).toBe(1)
    expect(await s.sweepExpired(later(40 * day), 30, 2), 'хвост не кончился').toBe(0)
  })

  it('чужой портал не подметает наши приглашения', async () => {
    const a = await store()
    const b = await store()
    await issue(a, { ttlMs: 60_000 })
    const day = 24 * 60 * 60_000
    expect(await b.sweepExpired(later(40 * day), 30), 'подмели чужой портал').toBe(0)
    expect(await a.sweepExpired(later(40 * day), 30), 'своё не подмели').toBe(1)
  })

  it('общепортальная чистка подметает ВСЕ порталы — иначе ПДн чужих арендаторов вечны (#49)', async () => {
    // ⚠️ Прямая противоположность предыдущему тесту, и оба нужны. Стор скоуплен порталом, значит
    // крон, ходивший через стор «портала по умолчанию», не трогал бы никого больше. Заметить это
    // неоткуда: крон молчит ровно так же, когда чистить нечего.
    // ⚠️ Чистим таблицу: эта проверка считает ВСЕ строки базы, а предыдущие тесты оставили свои.
    await db.query('delete from invitation')
    const a = await store()
    const b = await store()
    await issue(a, { ttlMs: 60_000 })
    await issue(b, { ttlMs: 60_000 })
    const day = 24 * 60 * 60_000
    expect(await sweepAllPortalsInvitations(db, later(2 * day), 30), 'подмели живое').toBe(0)
    expect(await sweepAllPortalsInvitations(db, later(40 * day), 30), 'подмели не всех').toBe(2)
  })

  it('общепортальная чистка соблюдает кап батча', async () => {
    await db.query('delete from invitation')
    const a = await store()
    const day = 24 * 60 * 60_000
    for (let i = 0; i < 3; i++) await issue(a, { ttlMs: 60_000 })
    expect(await sweepAllPortalsInvitations(db, later(40 * day), 30, 2)).toBe(2)
    expect(await sweepAllPortalsInvitations(db, later(40 * day), 30, 2)).toBe(1)
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

/**
 * ПАРИТЕТ двух реализаций одного порта.
 *
 * ⚠️ Заведён по итогам ревью, и не «на всякий случай»: расхождение уже было. `MemoryInvitationStore`
 * проверял «использована» раньше «протухла», а PostgreSQL-реализация — наоборот, и человек,
 * вернувшийся по письму через час после прохождения опроса, читал «срок ссылки истёк, попросите
 * новую» вместо «спасибо, опрос пройден» — то есть шёл зря дёргать менеджера. Поймали это глазами;
 * гейта, который поймал бы следующее такое, не было.
 *
 * Поэтому сценарии перечислены ОДИН раз и прогоняются через обе реализации, а сверяется не
 * «ожидание из теста», а совпадение реализаций между собой.
 */
describe('паритет: память и PostgreSQL отвечают одинаково', () => {
  const PIN2 = { surveyKey: 'k-parity', versionNo: 3 }
  const TTL = 5 * 60_000
  const hour = 60 * 60_000

  /** Каждый сценарий получает чистый стор и возвращает наблюдаемый результат. */
  const SCENARIOS: Record<string, (s: InvitationStore) => Promise<unknown>> = {
    'живая ссылка расходуется': async (s) => {
      const inv = await s.create({ ...PIN2, context: ctx }, NOW)
      return (await s.consume(inv.token, PIN2, NOW)).status
    },
    'повтор по израсходованной': async (s) => {
      const inv = await s.create({ ...PIN2, context: ctx }, NOW)
      await s.consume(inv.token, PIN2, NOW)
      return (await s.consume(inv.token, PIN2, NOW)).status
    },
    'ИЗРАСХОДОВАННАЯ, а потом ещё и протухшая': async (s) => {
      const inv = await s.create({ ...PIN2, context: ctx, ttlMs: TTL }, NOW)
      await s.consume(inv.token, PIN2, NOW)
      return (await s.consume(inv.token, PIN2, later(hour))).status
    },
    'протухшая, но не использованная': async (s) => {
      const inv = await s.create({ ...PIN2, context: ctx, ttlMs: TTL }, NOW)
      return (await s.consume(inv.token, PIN2, later(hour))).status
    },
    'чужой опрос': async (s) => {
      const inv = await s.create({ ...PIN2, context: ctx }, NOW)
      return (await s.consume(inv.token, { surveyKey: 'чужой', versionNo: 3 }, NOW)).status
    },
    'чужая версия': async (s) => {
      const inv = await s.create({ ...PIN2, context: ctx }, NOW)
      return (await s.consume(inv.token, { surveyKey: PIN2.surveyKey, versionNo: 99 }, NOW)).status
    },
    'после чужого пина ссылка ещё жива': async (s) => {
      const inv = await s.create({ ...PIN2, context: ctx }, NOW)
      await s.consume(inv.token, { surveyKey: 'чужой', versionNo: 3 }, NOW)
      return (await s.consume(inv.token, PIN2, NOW)).status
    },
    'неизвестный токен': async (s) => (await s.consume('нет-такого', PIN2, NOW)).status,
    'предпросмотр живой': async (s) => {
      const inv = await s.create({ ...PIN2, context: ctx }, NOW)
      return (await s.peek(inv.token, NOW))?.context
    },
    'предпросмотр израсходованной': async (s) => {
      const inv = await s.create({ ...PIN2, context: ctx }, NOW)
      await s.consume(inv.token, PIN2, NOW)
      return await s.peek(inv.token, NOW)
    },
    'предпросмотр протухшей': async (s) => {
      const inv = await s.create({ ...PIN2, context: ctx, ttlMs: TTL }, NOW)
      return await s.peek(inv.token, later(hour))
    }
  }

  for (const [name, run] of Object.entries(SCENARIOS)) {
    it(name, async () => {
      const inMemory = await run(new MemoryInvitationStore())
      const inPg = await run(new PgInvitationStore(db, { portalId: await freshPortal() }))
      expect(inPg, 'реализации одного порта разошлись').toEqual(inMemory)
    })
  }
})

describe('ИНВАРИАНТ ПОРТА: `peek` пуст ⇒ `consume` не сожжёт', () => {
  /**
   * Живой набор `peek` обязан быть НАДМНОЖЕСТВОМ сжигаемого набора `consume`.
   *
   * ⚠️ На этом стоит диагностика в `submit` (#170): когда `peek` вернул пусто, `consume` зовётся
   * РАДИ СТАТУСА — отличить «опрос пройден» от «ссылка протухла». Безопасно это только потому, что
   * жечь там нечего. Реализация, где `peek` строже (сузили предпросмотр, повесили кэш, разошлись
   * условия по сроку), начнёт жечь токены прямо на пути «мёртвый токен»: обладатель утёкшей ссылки
   * погасит чужое приглашение одним POST с мусорными ответами и верным `surveyKey`/`versionNo`.
   *
   * ⚠️ Проверять надо на ЖИВОМ приглашении в разных точках его срока — на мёртвых утверждение
   * выполняется само собой и мутацию не ловит (проверено: сужение `peek` такой набор переживает).
   */
  const PIN3 = { surveyKey: 'k-invariant', versionNo: 4 }
  const TTL5 = 5 * 60_000

  /** Нарушен ли инвариант в этой точке: `peek` уже молчит, а `consume` ещё жжёт. */
  async function violated(s: InvitationStore, atMs: number): Promise<boolean> {
    const inv = await s.create({ ...PIN3, context: ctx, ttlMs: TTL5 }, NOW)
    const at = later(atMs)
    const peekEmpty = (await s.peek(inv.token, at)) === undefined
    const burned = (await s.consume(inv.token, PIN3, at)).status === 'ok'
    return peekEmpty && burned
  }

  // Точки внутри срока, включая самый его хвост: сужение предпросмотра проявится именно там.
  const POINTS: Array<[string, number]> = [
    ['сразу после выписки', 0],
    ['в середине срока', TTL5 / 2],
    ['за 30 секунд до истечения', TTL5 - 30_000],
    ['за секунду до истечения', TTL5 - 1_000]
  ]

  for (const [name, atMs] of POINTS) {
    it(`память: ${name}`, async () => {
      expect(await violated(new MemoryInvitationStore(), atMs)).toBe(false)
    })
    it(`PostgreSQL: ${name}`, async () => {
      expect(await violated(new PgInvitationStore(db, { portalId: await freshPortal() }), atMs)).toBe(false)
    })
  }
})
