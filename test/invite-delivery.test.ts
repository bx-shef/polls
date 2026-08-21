import { describe, expect, it, vi } from 'vitest'
import { createKeySerializer } from '../src/api/serial-by-key'
import {
  INVITE_ORIGINATOR, decideInvite, deliverInvite, inviteMarker, manualInviteMarker, markerMatchesSurvey, resultMarker,
  type DeliverInviteDeps, type InviteDecisionInput, type MarkedActivity
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
  /** Полный вход: оба вопроса уже заданы. Правило отвечает окончательно. */
  const full = (over: Partial<InviteDecisionInput> = {}): InviteDecisionInput =>
    ({ activities: [], answeredAfterTransition: false, openElsewhere: 0, ...over })

  it('дел нет, чужих открытых нет, ответа нет → приглашаем', () => {
    expect(decideInvite(full())).toEqual({ action: 'create' })
  })

  it('дело ОТКРЫТО → молчим (это и есть отсечённая гроздь), и вопросов не задаём', () => {
    // Своё открытое дело закрывает вопрос само — портал за этим дёргать незачем.
    expect(decideInvite({ activities: [open] })).toEqual({ action: 'skip', reason: 'open' })
  })

  it('дело закрыто, ответа после перехода НЕТ → зовём снова', () => {
    // «Закрыто» значит, что менеджер снял задачу с себя, а не что клиента спросили.
    expect(decideInvite(full({ activities: [closed] }))).toEqual({ action: 'create' })
  })

  it('ответ ЕСТЬ → молчим, независимо от того, есть ли НАШИ дела (#198)', () => {
    // ⚠️ Условие `activities.length > 0` здесь СТОЯЛО и снято на ревью. Оно было верно, пока
    // единственным свидетельством «мы уже спрашивали» было наше собственное дело: оно создавалось
    // всегда. С правилом `open-other` автопуть может решить НЕ создавать — и свидетельства не
    // остаётся вовсе; тогда следующее событие того же перехода слало вторую ссылку УЖЕ ОТВЕТИВШЕМУ.
    // ⚠️ Прежнее обоснование («иначе любой прошлый ответ навсегда съедал бы новый законный переход»)
    // не держалось уже тогда: флаг называется `answeredAfterTransition` — он про ответ ПОСЛЕ ЭТОГО
    // перехода, а не «вообще». Новый переход даёт новый момент отсчёта и новый повод спросить.
    expect(decideInvite(full({ activities: [closed], answeredAfterTransition: true })))
      .toEqual({ action: 'skip', reason: 'answered' })
    expect(decideInvite(full({ activities: [], answeredAfterTransition: true })))
      .toEqual({ action: 'skip', reason: 'answered' })
  })

  it('чужое открытое приглашение → молчим (#198)', () => {
    expect(decideInvite(full({ openElsewhere: 1 }))).toEqual({ action: 'skip', reason: 'open-other' })
  })

  it('открытое дело перевешивает ответ — ждём именно его', () => {
    expect(decideInvite({ activities: [closed, open], answeredAfterTransition: true }))
      .toEqual({ action: 'skip', reason: 'open' })
  })

  it('НЕДОСТАЮЩИЙ ответ — это «спроси», а НЕ «создавай»', () => {
    // ⚠️ Раньше отсутствующий `openElsewhere` подразумевался нулём (`?? 0`), и результат был
    // неотличим от окончательного `create`. Потребитель, забывший второй шаг, получал тихо
    // выключенное правило — тот же класс дефекта, который #198 и чинит. Теперь «забыть» нельзя:
    // правило само называет, чего ему не хватает, и порядок вопросов живёт только здесь.
    expect(decideInvite({ activities: [] })).toEqual({ action: 'ask', need: 'answered' })
    expect(decideInvite({ activities: [], answeredAfterTransition: false }))
      .toEqual({ action: 'ask', need: 'open-elsewhere' })
    expect(decideInvite({ activities: [closed] })).toEqual({ action: 'ask', need: 'answered' })
  })
})

/**
 * Заготовка зависимостей: таймлайн пуст, ответов нет, создание отдаёт id.
 *
 * ⚠️ Двойник СОСТОЯТЕЛЬНЫЙ: созданное дело появляется в поиске, как на живом портале. Двойник,
 * который всегда отдаёт пустой список, тихо ломает всё, что зависит от read-after-write, — в том
 * числе контрольную проверку `markerVisible`, ради которой она и заведена.
 */
function deps(over: Partial<DeliverInviteDeps> = {}): DeliverInviteDeps & { created: () => number } {
  let createdCount = 0
  const timeline: MarkedActivity[] = []
  const base: DeliverInviteDeps = {
    findByMarker: () => Promise.resolve([...timeline]),
    answeredAfterTransition: () => Promise.resolve(false),
    // ⚠️ Считаем ПО ТОМУ ЖЕ таймлайну: на портале это один и тот же список дел, просто найденный
    // другим фильтром (по владельцу, а не по маркеру). Двойник, отдающий здесь константный ноль,
    // выключил бы правило #198 во всех тестах разом.
    countOpenForDeal: () => Promise.resolve(timeline.filter((a) => !a.completed).length),
    createInvite: () => {
      createdCount++
      const id = 100 + createdCount
      timeline.push({ id, completed: false })
      return Promise.resolve(id)
    },
    ensureMarker: () => Promise.resolve('already'),
    serializer: createKeySerializer(),
    serialKey: 'm-1:deal:759:csat_postdeal',
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
      markerFix: 'already',
      markerVisible: 'yes'
    })
  })

  it('поиск НЕ видит созданное дело → это видно наружу (защита не работает)', async () => {
    // Самый дорогой из непроверенных сценариев: `crm.activity.list` вживую сверен на ОБЫЧНОМ деле,
    // а настраиваемое вебхуком не создать. Если `list` не возвращает настраиваемые дела, дедуп —
    // no-op, и без этой проверки лог показывал бы ровное `markerFix: already`, то есть «всё хорошо»
    // при 2–4 письмах клиенту.
    const d = deps({ findByMarker: () => Promise.resolve([]) })
    const out = await deliverInvite('4242', 'k', d)
    expect(out.kind === 'created' && out.markerVisible).toBe('no')
  })

  it('контрольный поиск упал → вердикта нет, но приглашение НЕ теряется', async () => {
    // Приглашение к этому моменту уже выписано и дело создано. Ронять доставку из-за неудавшейся
    // ПРОВЕРКИ значило бы выбросить сделанную работу; выдавать сбой за «не видно» — врать в лог.
    let calls = 0
    const d = deps({
      findByMarker: () => {
        calls++
        return calls === 1 ? Promise.resolve([]) : Promise.reject(new Error('портал недоступен'))
      }
    })
    const out = await deliverInvite('4242', 'k', d)
    expect(out.kind).toBe('created')
    expect(out.kind === 'created' && out.markerVisible).toBe('unknown')
  })

  it('маркер дописать НЕ удалось → `failed` наружу, а не тихий «repaired»', async () => {
    // `crm.activity.update` отвечает успехом и когда поле для этого типа дела не поддерживается.
    const d = deps({ ensureMarker: () => Promise.resolve('failed') })
    const out = await deliverInvite('4242', 'k', d)
    expect(out.kind === 'created' && out.markerFix).toBe('failed')
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
      countOpenForDeal: async () => {
        await new Promise((r) => setImmediate(r))
        return timeline.filter((a) => !a.completed).length
      },
      createInvite: async () => {
        await new Promise((r) => setImmediate(r))
        const id = ++nextId
        timeline.push({ id, completed: false })
        return id
      },
      ensureMarker: () => Promise.resolve('already'),
      serializer,
      serialKey: 'm-1:deal:759:k'
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

  it('РАЗНЫЕ переходы: очередь их не путает, но живое приглашение остаётся ОДНО (#198)', async () => {
    // ⚠️ Тест изначально доказывал, что ключ очереди пер-переходный и переходы не съедают друг
    // друга. Это по-прежнему проверяется — тремя параллельными вызовами и отсутствием ошибок. Но
    // ПРАВИЛО изменилось: пока по сделке висит открытая ссылка, второй переход новую не выписывает,
    // иначе у клиента их две и по какой он ответит — решает случай.
    const timeline: Array<MarkedActivity & { key: string }> = []
    const serializer = createKeySerializer()
    let nextId = 0
    const d: DeliverInviteDeps = {
      findByMarker: async (m) => {
        await new Promise((r) => setImmediate(r))
        return timeline.filter((a) => a.key === m.originId)
      },
      answeredAfterTransition: () => Promise.resolve(false),
      countOpenForDeal: async () => {
        await new Promise((r) => setImmediate(r))
        return timeline.filter((a) => !a.completed).length
      },
      // ⚠️ Запись в таймлайн ПОСЛЕ ожидания — как настоящий REST. Пока двойник писал синхронно, до
      // первого `await`, тест был зелёным даже на переходном ключе очереди: гонки просто не
      // возникало. Ревью исполнило оба варианта и показало, что доказывал он тайминг двойника, а не
      // код. Один тик — и прежняя версия краснеет.
      createInvite: async (m) => {
        await new Promise((r) => setImmediate(r))
        const id = ++nextId
        timeline.push({ id, completed: false, key: m.originId })
        return id
      },
      ensureMarker: () => Promise.resolve('already'),
      serializer,
      // ⚠️ Ключ СДЕЛОЧНЫЙ — один на оба перехода. Переходный ключ (`…:${m.originId}`) означал бы
      // мьютекс только внутри одного перехода, и два перехода одной сделки создали бы по ссылке.
      serialKey: 'm-1:deal:759:k'
    }
    const out = await Promise.all([
      deliverInvite('1', 'k', d), deliverInvite('2', 'k', d), deliverInvite('1', 'k', d)
    ])
    expect(timeline, 'у клиента больше одной живой ссылки').toHaveLength(1)
    expect(out.filter((r) => r.kind === 'created')).toHaveLength(1)
  })

  it('ПРОПУСК по чужому приглашению не открывает дорогу второй ссылке ответившему (#198)', async () => {
    // ⚠️ Найдено исполнением на ревью. Цепочка: ручное приглашение открыто → событие перехода даёт
    // `open-other` и НИЧЕГО не создаёт → клиент отвечает по ручной ссылке → ручное дело закрывается
    // → приходит ещё одно событие ТОГО ЖЕ перехода (гроздь; окно свежести настраивается до часа).
    // Своих дел нет, чужих открытых больше нет — и без вопроса «а не ответил ли он» автопуть слал бы
    // вторую ссылку уже ответившему.
    let manualOpen = true
    let answered = false
    const d = deps({
      findByMarker: () => Promise.resolve([]),
      countOpenForDeal: () => Promise.resolve(manualOpen ? 1 : 0),
      answeredAfterTransition: () => Promise.resolve(answered)
    })
    expect((await deliverInvite('4242', 'k', d)).kind).toBe('skipped')

    // Клиент ответил по ручной ссылке, дело закрылось.
    manualOpen = false
    answered = true

    const second = await deliverInvite('4242', 'k', d)
    expect(second, 'вторая ссылка ушла уже ответившему клиенту')
      .toEqual({ kind: 'skipped', reason: 'answered', marker: inviteMarker('4242', 'k') })
    expect(d.created()).toBe(0)
  })

  it('РАЗНЫЕ порталы не ждут друг друга — портал входит в ключ очереди', async () => {
    // ⚠️ ID записей истории стадий у разных порталов совпадают штатно (они мелкие и свои у каждого).
    // Потеряй ключ портал — медленный REST одного арендатора держал бы очередь другому. Мутация
    // «убрать `memberId` из ключа» проходила набор: исход тот же, страдает только время.
    let active = 0
    let peak = 0
    const mk = (serialKey: string): DeliverInviteDeps => ({
      findByMarker: async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setImmediate(r))
        active--
        return []
      },
      answeredAfterTransition: () => Promise.resolve(false),
      countOpenForDeal: () => Promise.resolve(0),
      createInvite: () => Promise.resolve(1),
      ensureMarker: () => Promise.resolve('already'),
      serializer,
      serialKey
    })
    const serializer = createKeySerializer()
    await Promise.all([
      deliverInvite('1', 'k', mk('m-1:deal:759:k')),
      deliverInvite('1', 'k', mk('m-2:deal:759:k'))
    ])
    expect(peak, 'два портала встали в одну очередь').toBe(2)
  })

  it('прошлый переход ЗАКРЫТ без ответа → новый переход зовёт снова', async () => {
    // «Закрыто» значит, что менеджер снял задачу с себя, а не что клиента спросили. Правило #198
    // молчит про закрытые дела — иначе одна забытая задача выключила бы опрос по сделке навсегда.
    const timeline: Array<MarkedActivity & { key: string }> = [{ id: 1, completed: true, key: 'stage:1:k' }]
    const d: DeliverInviteDeps = {
      findByMarker: (m) => Promise.resolve(timeline.filter((a) => a.key === m.originId)),
      answeredAfterTransition: () => Promise.resolve(false),
      countOpenForDeal: () => Promise.resolve(timeline.filter((a) => !a.completed).length),
      createInvite: (m) => {
        timeline.push({ id: timeline.length + 1, completed: false, key: m.originId })
        return Promise.resolve(timeline.length)
      },
      ensureMarker: () => Promise.resolve('already'),
      serializer: createKeySerializer(),
      serialKey: 'm-1:deal:759:k'
    }
    expect((await deliverInvite('2', 'k', d)).kind).toBe('created')
  })

  it('РУЧНОЕ приглашение висит открытым → переход НЕ шлёт вторую ссылку (#198)', async () => {
    // ⚠️ Поиск по маркеру этого дела не видит по построению: у ручного пути маркер свой (`manual:`).
    // До правила менеджер, нажавший «Создать ссылку», а потом протащивший сделку через стадию, слал
    // клиенту ДВЕ живые ссылки на один опрос.
    const d = deps({
      findByMarker: () => Promise.resolve([]),
      countOpenForDeal: () => Promise.resolve(1)
    })
    const out = await deliverInvite('4242', 'csat_postdeal', d)
    expect(out).toEqual({ kind: 'skipped', reason: 'open-other', marker: inviteMarker('4242', 'csat_postdeal') })
    expect(d.created(), 'выписана вторая живая ссылка').toBe(0)
  })

  it('чужие открытые приглашения спрашиваются ЛЕНИВО — гроздь их не оплачивает', async () => {
    // Лишний `crm.activity.list` на каждое событие грозди — это 2–4 запроса к порталу вместо нуля.
    const probe = vi.fn(() => Promise.resolve(0))
    const d = deps({ findByMarker: () => Promise.resolve([{ id: 7, completed: false }]), countOpenForDeal: probe })
    const out = await deliverInvite('4242', 'csat_postdeal', d)
    expect(out.kind).toBe('skipped')
    expect(probe, 'портал спрошен там, где решение уже принято').not.toHaveBeenCalled()
  })

  it('отказ страховки НЕ глушится здесь — это обязанность вызывающего', async () => {
    // ⚠️ Прежняя версия этого теста подменяла `countOpenForDeal` на `() => 0` и была тавтологией:
    // база `deps()` при пустом таймлайне отдаёт ровно ноль, то есть оверрайд не менял ничего, а
    // заголовок обещал проверку fail-open. Настоящий fail-open живёт в проводке
    // (`test/invite-issue.test.ts`), и здесь важно зафиксировать обратное: ядро отказ НЕ глотает.
    // Иначе кто-то «упростит» проводку, сняв `.catch`, и потеря страховки станет молчаливой.
    const d = deps({ countOpenForDeal: () => Promise.reject(new Error('портал недоступен')) })
    await expect(deliverInvite('4242', 'csat_postdeal', d)).rejects.toThrow('портал недоступен')
    expect(d.created(), 'приглашение выписано на сломанном входе').toBe(0)
  })
})

describe('маркер → «тот ли опрос» (закрытие дела при ответе, #177)', () => {
  it('свой опрос узнаётся, чужой — нет', () => {
    expect(markerMatchesSurvey(inviteMarker('4242', 'csat').originId, 'csat')).toBe(true)
    expect(markerMatchesSurvey(inviteMarker('4242', 'nps').originId, 'csat')).toBe(false)
  })

  it('ПРЕФИКС ключа опроса не считается совпадением', () => {
    // ⚠️ Зеркало проверки хвоста, и оно не теоретическое: `csat` и `csat_postdeal` — буквально ключи
    // из примеров этого репозитория. Мутация `=== surveyKey` → `.startsWith(surveyKey)` проходила
    // весь набор, а стоит она двух дефектов сразу: открытое приглашение по `csat_postdeal`
    // блокировало бы переход по `csat` (#198), а ответ по `csat` ЗАКРЫВАЛ бы живое приглашение по
    // `csat_postdeal` на той же сделке (#177).
    expect(markerMatchesSurvey('stage:1:csat_postdeal', 'csat')).toBe(false)
    expect(markerMatchesSurvey('manual:1755770000:csat_postdeal', 'csat')).toBe(false)
    expect(markerMatchesSurvey('stage:1:csat', 'csat'), 'точное совпадение перестало работать').toBe(true)
  })

  it('префикс маркера сверяется с НАЧАЛОМ строки, а не «где-то внутри»', () => {
    // `.startsWith` → `.includes` проходило набор: в негативах был `other:4242:csat`, но не строка с
    // нашим префиксом в середине.
    expect(markerMatchesSurvey('x:stage:1:csat', 'csat')).toBe(false)
  })

  it('ХВОСТ маркера не считается совпадением', () => {
    // ⚠️ Ровно то, ради чего здесь разбор, а не `endsWith(':' + surveyKey)`: ключ опроса —
    // произвольная строка, и ответ по `csat` закрыл бы дело по `nps_csat`, то есть погасил бы
    // приглашение на ДРУГОЙ опрос той же сделки.
    expect(markerMatchesSurvey(inviteMarker('4242', 'nps_csat').originId, 'csat')).toBe(false)
  })

  it('чужая форма маркера, пусто и мусор → не наше', () => {
    for (const bad of [
      undefined, '', 'csat', 'stage:csat', 'other:4242:csat', 'STAGE:4242:csat',
      // Ручная форма симметрична автоматической — негативы обязаны совпадать (#176).
      'manual:csat', 'MANUAL:4242:csat', 'manualx:4242:csat'
    ]) {
      expect(markerMatchesSurvey(bad, 'csat'), String(bad)).toBe(false)
    }
  })

  it('ключ опроса С ДВОЕТОЧИЕМ — это НАШ маркер', () => {
    // ⚠️ `surveyKey` — обычная строка (`z.string().min(1).max(200)`), двоеточие в нём разрешено.
    // Разбор на равные части отверг бы `csat:2026` как чужой: дело не закрывалось бы НИКОГДА, и в
    // логе это выглядело бы как «дел не было». Ключ перехода двоеточий не содержит по построению.
    expect(markerMatchesSurvey(inviteMarker('4242', 'csat:2026').originId, 'csat:2026')).toBe(true)
    expect(markerMatchesSurvey('stage:4242:a:b', 'a:b')).toBe(true)
    // И хвостовое совпадение по-прежнему отвергается.
    expect(markerMatchesSurvey('stage:4242:x:a:b', 'a:b')).toBe(false)
  })

  it('РУЧНОЙ маркер — тоже приглашение, а дело-результат — нет (#176)', () => {
    // ⚠️ Обе формы приглашения обязаны узнаваться. Не узнавай мы ручное дело, оно не участвовало бы
    // ни в дедупе следующего нажатия, ни в закрытии при ответе (#177): висело бы в карточке открытым
    // вечно, а правило «уже приглашали?» о нём молчало бы.
    expect(markerMatchesSurvey(manualInviteMarker(1787220000, 'csat').originId, 'csat')).toBe(true)
    expect(markerMatchesSurvey(manualInviteMarker(1787220000, 'nps').originId, 'csat')).toBe(false)
    // ⚠️ А `result:` — НЕ приглашение. Совпади префиксы, ответ клиента «закрывал» бы запись о
    // собственном результате, и в логе это выглядело бы нормальной работой.
    expect(markerMatchesSurvey(resultMarker('r-1').originId, 'csat')).toBe(false)
    expect(markerMatchesSurvey('result:4242:csat', 'csat')).toBe(false)
    // Хвостовое совпадение отвергается и у ручной формы.
    expect(markerMatchesSurvey('manual:1:x:a:b', 'a:b')).toBe(false)
    expect(markerMatchesSurvey('manual:1:a:b', 'a:b')).toBe(true)
  })
})

describe('маркер ручного приглашения (#176)', () => {
  it('форма — `manual:<секунды>:<опрос>`, ключ приложения тот же', () => {
    const m = manualInviteMarker(1787220000, 'csat')
    expect(m.originatorId).toBe(INVITE_ORIGINATOR)
    expect(m.originId).toBe('manual:1787220000:csat')
  })

  it('не пересекается с автоматическим маркером того же опроса', () => {
    // ⚠️ Свой префикс, а не `stage:` с выдуманным переходом: подделав ключ перехода, ручное дело
    // начало бы съедать приглашение по НАСТОЯЩЕМУ переходу как дубль.
    expect(manualInviteMarker(4242, 'csat').originId).not.toBe(inviteMarker('4242', 'csat').originId)
  })

  it('дробные секунды режутся: ключ — целое, без точек и лишних двоеточий', () => {
    const id = manualInviteMarker(1787220000.9, 'csat').originId
    expect(id).toBe('manual:1787220000:csat')
    expect(id.split(':')).toHaveLength(3)
  })
})
