import { describe, expect, it, vi } from 'vitest'
import { createKeySerializer } from '../src/api/serial-by-key'
import {
  INVITE_ORIGINATOR, decideInvite, deliverInvite, inviteMarker,
  type DeliverInviteDeps, type MarkedActivity
} from '../src/bitrix24/invite-delivery'

describe('маркер дела-приглашения', () => {
  it('форма маркера запиннена литералом', () => {
    // Маркер — это то, по чему дело ИЩЕТСЯ. Смена формы означает, что все уже созданные дела
    // перестают находиться разом, то есть каждая сделка получает второе приглашение.
    expect(inviteMarker('4242', 'csat_postdeal')).toEqual({
      originatorId: 'bx-shef.polls',
      originId: 'stage:4242:csat_postdeal'
    })
    expect(INVITE_ORIGINATOR).toBe('bx-shef.polls')
  })

  it('разные опросы одного перехода — РАЗНЫЕ маркеры', () => {
    // Один переход может запускать несколько опросов, и каждый заслуживает своё приглашение.
    const a = inviteMarker('4242', 'csat_postdeal').originId
    const b = inviteMarker('4242', 'nps_quarterly').originId
    expect(a).not.toBe(b)
  })

  it('разные переходы одной сделки — РАЗНЫЕ маркеры', () => {
    // Сделка может вернуться в ту же стадию: это законный повод спросить снова, а не дубль.
    expect(inviteMarker('4242', 'k').originId).not.toBe(inviteMarker('5001', 'k').originId)
  })
})

describe('правило «уже приглашали?» — таблица целиком', () => {
  const open: MarkedActivity = { id: 1, completed: false }
  const closed: MarkedActivity = { id: 2, completed: true }

  it('дел нет → приглашаем', () => {
    expect(decideInvite({ activities: [], answeredAfterTransition: false })).toEqual({ action: 'create' })
  })

  it('дело ОТКРЫТО → молчим (это и есть отсечённая гроздь)', () => {
    expect(decideInvite({ activities: [open], answeredAfterTransition: false }))
      .toEqual({ action: 'skip', reason: 'open' })
  })

  it('дело закрыто, ответа после перехода НЕТ → зовём снова', () => {
    // «Закрыто» значит, что менеджер снял задачу с себя, а не что клиента спросили.
    expect(decideInvite({ activities: [closed], answeredAfterTransition: false })).toEqual({ action: 'create' })
  })

  it('дело закрыто, ответ ЕСТЬ → молчим, цикл завершён', () => {
    expect(decideInvite({ activities: [closed], answeredAfterTransition: true }))
      .toEqual({ action: 'skip', reason: 'answered' })
  })

  it('открытое дело перевешивает ответ — ждём именно его', () => {
    expect(decideInvite({ activities: [closed, open], answeredAfterTransition: true }))
      .toEqual({ action: 'skip', reason: 'open' })
  })
})

/** Заготовка зависимостей: по умолчанию дел нет, ответов нет, создание отдаёт id. */
function deps(over: Partial<DeliverInviteDeps> = {}): DeliverInviteDeps & { created: () => number } {
  let createdCount = 0
  const base: DeliverInviteDeps = {
    findByMarker: () => Promise.resolve([]),
    answeredAfterTransition: () => Promise.resolve(false),
    createInvite: () => { createdCount++; return Promise.resolve(100 + createdCount) },
    ensureMarker: () => Promise.resolve('already'),
    serializer: createKeySerializer(),
    ...over
  }
  return { ...base, created: () => createdCount }
}

describe('доставка приглашения целиком', () => {
  it('пустой таймлайн → создано, маркер на месте', async () => {
    const d = deps()
    const out = await deliverInvite('4242', 'csat_postdeal', d)
    expect(out).toEqual({
      kind: 'created',
      activityId: 101,
      marker: { originatorId: 'bx-shef.polls', originId: 'stage:4242:csat_postdeal' },
      markerFix: 'already'
    })
  })

  it('маркер не прижился при создании → дописывается, и это видно наружу', async () => {
    // `configurable.add` недоступен вебхуку, поэтому принимает ли он поля маркера — выяснится только
    // на установленном приложении. Ставка на «примет» стоила бы второго приглашения каждой сделке.
    const d = deps({ ensureMarker: () => Promise.resolve('repaired') })
    const out = await deliverInvite('4242', 'k', d)
    expect(out.kind === 'created' && out.markerFix).toBe('repaired')
  })

  it('открытое дело → не создаём ничего и НЕ спрашиваем про ответы', async () => {
    // Лишний запрос к своей базе на каждое событие грозди — это плата ни за что: открытое дело
    // закрывает вопрос само.
    const answered = vi.fn(() => Promise.resolve(true))
    const d = deps({ findByMarker: () => Promise.resolve([{ id: 7, completed: false }]), answeredAfterTransition: answered })
    const out = await deliverInvite('4242', 'k', d)
    expect(out).toMatchObject({ kind: 'skipped', reason: 'open' })
    expect(d.created()).toBe(0)
    expect(answered, 'спросили про ответы там, где это ничего не решает').not.toHaveBeenCalled()
  })

  it('закрытое дело + ответ → молчим', async () => {
    const d = deps({
      findByMarker: () => Promise.resolve([{ id: 7, completed: true }]),
      answeredAfterTransition: () => Promise.resolve(true)
    })
    expect(await deliverInvite('4242', 'k', d)).toMatchObject({ kind: 'skipped', reason: 'answered' })
    expect(d.created()).toBe(0)
  })

  it('ГРОЗДЬ событий одного перехода даёт РОВНО ОДНО приглашение', async () => {
    // ⚠️ Главный тест этой работы. Живая проверка на портале показала: два дела с одним маркером
    // Bitrix24 создаёт спокойно — уникальность не его забота. Значит одновременность закрываем мы:
    // «поиск → создание» идёт под очередью по ключу. Здесь три события стартуют одновременно, и
    // портал имитируется честно — созданные дела попадают в тот же список, по которому идёт поиск.
    const timeline: MarkedActivity[] = []
    const serializer = createKeySerializer()
    let nextId = 500
    const d: DeliverInviteDeps = {
      // Оба обращения к «порталу» асинхронны с реальным переключением — без этого проверка
      // выродилась бы: синхронный фейк не даёт второму обработчику влезть в промежуток.
      findByMarker: async () => { await new Promise((r) => setImmediate(r)); return [...timeline] },
      answeredAfterTransition: () => Promise.resolve(false),
      createInvite: async () => {
        await new Promise((r) => setImmediate(r))
        const id = ++nextId
        timeline.push({ id, completed: false })
        return id
      },
      ensureMarker: () => Promise.resolve('already'),
      serializer
    }

    const results = await Promise.all([
      deliverInvite('4242', 'k', d),
      deliverInvite('4242', 'k', d),
      deliverInvite('4242', 'k', d)
    ])
    expect(timeline, 'по одному переходу создано больше одного дела').toHaveLength(1)
    expect(results.filter((r) => r.kind === 'created')).toHaveLength(1)
    expect(results.filter((r) => r.kind === 'skipped')).toHaveLength(2)
  })

  it('РАЗНЫЕ переходы не мешают друг другу', async () => {
    const timeline: MarkedActivity[] = []
    const serializer = createKeySerializer()
    let nextId = 0
    const d: DeliverInviteDeps = {
      findByMarker: async (m) => {
        await new Promise((r) => setImmediate(r))
        return timeline.filter((a) => (a as MarkedActivity & { key?: string }).key === m.originId)
      },
      answeredAfterTransition: () => Promise.resolve(false),
      createInvite: async (m) => {
        const id = ++nextId
        timeline.push({ id, completed: false, key: m.originId } as MarkedActivity & { key: string })
        return id
      },
      ensureMarker: () => Promise.resolve('already'),
      serializer
    }
    const out = await Promise.all([
      deliverInvite('1', 'k', d), deliverInvite('2', 'k', d), deliverInvite('1', 'k', d)
    ])
    expect(timeline, 'переходы съели друг друга').toHaveLength(2)
    expect(out.filter((r) => r.kind === 'created')).toHaveLength(2)
  })
})
