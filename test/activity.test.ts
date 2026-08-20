import { describe, expect, it, vi } from 'vitest'
import {
  buildSurveyInviteActivity,
  buildSurveyResultActivity,
  activityConfigurableAdd,
  activityListByMarker,
  ensureActivityMarker,
  dealDetailPath,
  DEAL_OWNER_TYPE_ID,
  SURVEY_ACTIVITY_LOGO,
  type SurveyInviteActivityInput
} from '../src/bitrix24/activity'
import type { ResultLine } from '../src/domain/result-summary'
import type { PortalClient, CallResult } from '../src/bitrix24/client'

const input = (over: Partial<SurveyInviteActivityInput> = {}): SurveyInviteActivityInput => ({
  dealId: 759,
  surveyTitle: 'CSAT после сделки',
  surveyKey: 'csat_postdeal',
  token: 'tok-abc',
  surveyUrl: 'https://polls.bx-shef.by/s/csat_postdeal?token=tok-abc',
  ...over
})

/** Мок PortalClient (как в client.test): фиксируем метод+params, отдаём заданный результат. */
function ok(result: unknown): CallResult {
  return { isSuccess: true, getData: () => ({ result, time: {} }), getErrorMessages: () => [] }
}
function client(res: CallResult): PortalClient & { calls: unknown[][] } {
  const calls: unknown[][] = []
  const make = vi.fn(async (opts: { method: string; params?: object }) => (calls.push([opts.method, opts.params]), res))
  return { calls, actions: { v2: { call: { make } } } }
}

describe('dealDetailPath — same-portal относительный путь карточки сделки', () => {
  it('числовой id → /crm/deal/details/<id>/ (без схемы/хоста — SSRF-safe)', () => {
    expect(dealDetailPath(759)).toBe('/crm/deal/details/759/')
    expect(dealDetailPath(1).startsWith('/crm/')).toBe(true)
  })
})

describe('buildSurveyInviteActivity — параметры настраиваемого дела (Фаза F)', () => {
  it('привязка к сделке: ownerTypeId=2 (deal) + ownerId=dealId', () => {
    const a = buildSurveyInviteActivity(input({ dealId: 42 }))
    expect(a.ownerTypeId).toBe(DEAL_OWNER_TYPE_ID)
    expect(DEAL_OWNER_TYPE_ID).toBe(2)
    expect(a.ownerId).toBe(42)
  })

  it('fields: настраиваемая невыполненная активность (typeId CONFIGURABLE, completed N)', () => {
    const a = buildSurveyInviteActivity(input())
    expect(a.fields).toEqual({ typeId: 'CONFIGURABLE', completed: 'N' })
  })

  it('responsibleId: включается при наличии, опускается без него', () => {
    expect(buildSurveyInviteActivity(input({ responsibleId: 17 })).fields.responsibleId).toBe(17)
    expect(buildSurveyInviteActivity(input()).fields).not.toHaveProperty('responsibleId')
  })

  it('шапка — название опроса; иконка — валидный код логотипа', () => {
    const a = buildSurveyInviteActivity(input({ surveyTitle: 'NPS' }))
    expect(a.layout.header).toEqual({ title: 'Опрос: NPS' })
    expect(a.layout.icon).toEqual({ code: SURVEY_ACTIVITY_LOGO })
  })

  it('body.logo ОБЯЗАТЕЛЕН (иначе Bitrix отвергает) → redirect на карточку сделки (relative)', () => {
    const a = buildSurveyInviteActivity(input({ dealId: 7 }))
    expect(a.layout.body.logo).toEqual({
      code: SURVEY_ACTIVITY_LOGO,
      action: { type: 'redirect', uri: '/crm/deal/details/7/' }
    })
  })

  it('тело: ссылка на анкету сохранена ТЕКСТОМ (внешний URL, не redirect)', () => {
    const a = buildSurveyInviteActivity(input({ surveyUrl: 'https://x/s/k?token=t' }))
    expect(a.layout.body.blocks.surveyLink).toEqual({ type: 'text', properties: { value: 'https://x/s/k?token=t' } })
  })

  it('футер: одна кнопка «Отправить приглашение» → openRestApp с контекстом отправки', () => {
    const a = buildSurveyInviteActivity(input({ dealId: 7, surveyKey: 'k', token: 'tk', surveyUrl: 'https://p/s/k?token=tk' }))
    expect(Object.keys(a.layout.footer.buttons)).toEqual(['sendInvite']) // ≤2 кнопок футера
    expect(a.layout.footer.buttons.sendInvite).toEqual({
      title: 'Отправить приглашение',
      type: 'primary',
      action: {
        type: 'openRestApp',
        // `url` — та же строка, что записана текстом в теле дела: иначе менеджер видит одну ссылку,
        // а копирует из виджета другую (домен приложения vs origin iframe).
        actionParams: { surveyKey: 'k', token: 'tk', dealId: 7, url: 'https://p/s/k?token=tk' }
      }
    })
  })

  it('длинный заголовок обрезается до 255 (защита payload)', () => {
    const a = buildSurveyInviteActivity(input({ surveyTitle: 'Ы'.repeat(400) }))
    expect((a.layout.header.title as string).length).toBe(255)
  })

  it('длинный surveyUrl обрезается до 500 (backstop payload — симметрично капу заголовка)', () => {
    const a = buildSurveyInviteActivity(input({ surveyUrl: 'https://x/s/k?token=' + 't'.repeat(600) }))
    const link = a.layout.body.blocks.surveyLink as { properties: { value: string } }
    expect(link.properties.value.length).toBe(500)
  })

  it('BB-нейтрализация: скобки [] в заголовке и ссылке → полноширинные (анти-инъекция таймлайна)', () => {
    const a = buildSurveyInviteActivity(input({ surveyTitle: 'A [url=http://evil]x[/url]', surveyUrl: 'https://x/s/k?a=[b]' }))
    const title = a.layout.header.title as string
    expect(title).not.toMatch(/[[\]]/) // нет сырых ASCII-скобок BB
    expect(title).toContain('［url=http://evil］')
    const link = (a.layout.body.blocks.surveyLink as { properties: { value: string } }).properties.value
    expect(link).not.toMatch(/[[\]]/)
  })

  it('инварианты Bitrix: блоков тела 1..20, кнопок футера ≤2', () => {
    const a = buildSurveyInviteActivity(input())
    const blocks = Object.keys(a.layout.body.blocks).length
    expect(blocks).toBeGreaterThanOrEqual(1)
    expect(blocks).toBeLessThanOrEqual(20)
    expect(Object.keys(a.layout.footer.buttons).length).toBeLessThanOrEqual(2)
  })
})

describe('buildSurveyResultActivity — результат опроса в таймлайн (#18)', () => {
  const lines: ResultLine[] = [
    { label: 'Оцените', value: '9' },
    { label: 'Комментарий', value: 'отличный сервис' }
  ]
  const rInput = { dealId: 759, surveyTitle: 'CSAT', lines, responseId: 'r42' }

  it('запись о завершённом опросе: completed=Y (в отличие от pending-приглашения N)', () => {
    expect(buildSurveyResultActivity(rInput).fields).toEqual({ typeId: 'CONFIGURABLE', completed: 'Y' })
  })

  it('responsibleId включается при наличии (симметрично приглашению)', () => {
    expect(buildSurveyResultActivity({ ...rInput, responsibleId: 17 }).fields.responsibleId).toBe(17)
  })

  it('привязка/шапка/обязательный logo — как у приглашения', () => {
    const a = buildSurveyResultActivity({ ...rInput, dealId: 7 })
    expect(a.ownerTypeId).toBe(DEAL_OWNER_TYPE_ID)
    expect(a.ownerId).toBe(7)
    expect(a.layout.header).toEqual({ title: 'Результат опроса: CSAT' })
    expect(a.layout.body.logo).toEqual({ code: SURVEY_ACTIVITY_LOGO, action: { type: 'redirect', uri: '/crm/deal/details/7/' } })
  })

  it('тело: по блоку на строку сводки «метка: значение»', () => {
    const a = buildSurveyResultActivity(rInput)
    expect(a.layout.body.blocks.line0).toEqual({ type: 'text', properties: { value: 'Оцените: 9' } })
    expect(a.layout.body.blocks.line1).toEqual({ type: 'text', properties: { value: 'Комментарий: отличный сервис' } })
    expect(Object.keys(a.layout.body.blocks)).toHaveLength(2)
  })

  it('пустая сводка → один блок-заглушка (Bitrix требует ≥1 блок)', () => {
    const a = buildSurveyResultActivity({ ...rInput, lines: [] })
    expect(Object.keys(a.layout.body.blocks)).toHaveLength(1)
    expect(a.layout.body.blocks.line0).toEqual({ type: 'text', properties: { value: 'Опрос заполнен: без ответов' } })
  })

  it('кнопка «Открыть результат» → openRestApp с responseId+dealId', () => {
    const a = buildSurveyResultActivity({ ...rInput, dealId: 7, responseId: 'r42' })
    expect(a.layout.footer.buttons.openResult).toEqual({
      title: 'Открыть результат',
      type: 'primary',
      action: { type: 'openRestApp', actionParams: { responseId: 'r42', dealId: 7 } }
    })
  })

  it('BB-нейтрализация метки/значения сводки (анти-инъекция таймлайна)', () => {
    const a = buildSurveyResultActivity({ ...rInput, lines: [{ label: 'A [x]', value: '[url=e]v[/url]' }] })
    const v = (a.layout.body.blocks.line0 as { properties: { value: string } }).properties.value
    expect(v).not.toMatch(/[[\]]/)
  })

  it('число блоков не превышает 20 (инвариант Bitrix) даже при длинной сводке', () => {
    const many: ResultLine[] = Array.from({ length: 40 }, (_, i) => ({ label: `Q${i}`, value: String(i) }))
    const a = buildSurveyResultActivity({ ...rInput, lines: many })
    expect(Object.keys(a.layout.body.blocks).length).toBe(20) // ровно кап, не тесней

  })
})

describe('activityConfigurableAdd — REST-обёртка', () => {
  it('зовёт crm.activity.configurable.add с параметрами билдера → id активности', async () => {
    const c = client(ok(9012))
    const params = buildSurveyInviteActivity(input())
    const id = await activityConfigurableAdd(c, params)
    expect(id).toBe(9012)
    expect(c.calls[0]).toEqual(['crm.activity.configurable.add', params])
  })

  it('id-строка от B24 коэрсится в number (тип не лжёт)', async () => {
    const c = client(ok('9012')) // B24 REST местами сериализует id строкой
    const id = await activityConfigurableAdd(c, buildSurveyInviteActivity(input()))
    expect(id).toBe(9012)
    expect(typeof id).toBe('number')
  })
})

/** Мок PortalClient с ОЧЕРЕДЬЮ ответов: `ensureActivityMarker` делает несколько вызовов подряд. */
function clientSeq(...res: CallResult[]): PortalClient & { calls: unknown[][] } {
  const calls: unknown[][] = []
  let i = 0
  const make = vi.fn(async (opts: { method: string; params?: object }) => {
    calls.push([opts.method, opts.params])
    return res[Math.min(i++, res.length - 1)]!
  })
  return { calls, actions: { v2: { call: { make } } } }
}

describe('ensureActivityMarker — маркер на созданном деле', () => {
  const marker = { originatorId: 'bx-shef.polls', originId: 'stage:4242:csat_postdeal' }

  it('маркер уже на месте → `already`, БЕЗ лишней записи', async () => {
    const c = clientSeq(ok({ ORIGINATOR_ID: 'bx-shef.polls', ORIGIN_ID: 'stage:4242:csat_postdeal' }))
    expect(await ensureActivityMarker(c, 101, marker)).toBe('already')
    expect(c.calls.map((x) => x[0])).toEqual(['crm.activity.get'])
  })

  it('маркера нет → дописываем и ПЕРЕЧИТЫВАЕМ; прижился → `repaired`', async () => {
    const c = clientSeq(ok({}), ok(true), ok({ ORIGINATOR_ID: 'bx-shef.polls', ORIGIN_ID: 'stage:4242:csat_postdeal' }))
    expect(await ensureActivityMarker(c, 101, marker)).toBe('repaired')
    expect(c.calls.map((x) => x[0])).toEqual(['crm.activity.get', 'crm.activity.update', 'crm.activity.get'])
    expect(c.calls[1]![1]).toEqual({
      id: 101,
      fields: { ORIGINATOR_ID: 'bx-shef.polls', ORIGIN_ID: 'stage:4242:csat_postdeal' }
    })
  })

  it('update ответил успехом, а поля НЕТ → `failed`, а не тихий `repaired`', async () => {
    // Ровно тот случай, ради которого заведено перечитывание: `crm.activity.update` возвращает
    // успех и когда поле для этого типа дела не поддерживается. Без сверки провал защиты выглядел
    // бы в логе как её работа — а дело, которое поиск не находит, даёт второе приглашение.
    const c = clientSeq(ok({}), ok(true), ok({}))
    expect(await ensureActivityMarker(c, 101, marker)).toBe('failed')
  })

  it('чужой маркер на деле → перезаписываем своим', async () => {
    const c = clientSeq(
      ok({ ORIGINATOR_ID: 'other.app', ORIGIN_ID: 'stage:9999:other' }),
      ok(true),
      ok({ ORIGINATOR_ID: 'bx-shef.polls', ORIGIN_ID: 'stage:4242:csat_postdeal' })
    )
    expect(await ensureActivityMarker(c, 101, marker)).toBe('repaired')
  })

  it('ORIGIN_ID принят, а ORIGINATOR_ID НЕТ → чиним, а не рапортуем `already`', async () => {
    // Худший из исходов, если сверять одно поле: поиск фильтрует по ДВУМ, дело по нему не находится,
    // и следующее событие грозди выписывает второе приглашение — при `markerFix: already` в логе.
    const c = clientSeq(
      ok({ ORIGIN_ID: 'stage:4242:csat_postdeal' }),
      ok(true),
      ok({ ORIGINATOR_ID: 'bx-shef.polls', ORIGIN_ID: 'stage:4242:csat_postdeal' })
    )
    expect(await ensureActivityMarker(c, 101, marker)).toBe('repaired')
  })
})

describe('activityListByMarker — поиск наших дел', () => {
  const marker = { originatorId: 'bx-shef.polls', originId: 'stage:4242:csat_postdeal' }

  it('фильтрует по ОБОИМ полям маркера и по сделке', async () => {
    // `ORIGINATOR_ID` отделяет наши дела от чужих интеграторов; `OWNER_ID` — от подложенных в другие
    // сделки (маркер угадывается: ключ опроса виден в нашей же ссылке, ID истории монотонны).
    const c = client(ok([]))
    await activityListByMarker(c, marker, 759)
    expect(c.calls[0]).toEqual(['crm.activity.list', {
      filter: {
        ORIGINATOR_ID: 'bx-shef.polls',
        ORIGIN_ID: 'stage:4242:csat_postdeal',
        OWNER_TYPE_ID: DEAL_OWNER_TYPE_ID,
        OWNER_ID: 759
      },
      select: ['ID', 'COMPLETED']
    }])
  })

  it('без сделки — фильтр только по маркеру', async () => {
    const c = client(ok([]))
    await activityListByMarker(c, marker)
    expect((c.calls[0]![1] as { filter: Record<string, unknown> }).filter)
      .toEqual({ ORIGINATOR_ID: 'bx-shef.polls', ORIGIN_ID: 'stage:4242:csat_postdeal' })
  })

  it('COMPLETED=Y → закрыто, N и отсутствие → ОТКРЫТО', async () => {
    // Инверсия этого признака прямо возвращает #138: открытое дело прочиталось бы как закрытое →
    // правило пошло бы в ветку «закрыто без ответа» → второе приглашение на каждое событие грозди.
    const c = client(ok([{ ID: 1, COMPLETED: 'Y' }, { ID: 2, COMPLETED: 'N' }, { ID: 3 }]))
    expect(await activityListByMarker(c, marker, 759)).toEqual([
      { id: 1, completed: true },
      { id: 2, completed: false },
      { id: 3, completed: false }
    ])
  })

  it('id строкой коэрсится; нечитаемый id → 0, но строка ОСТАЁТСЯ', async () => {
    // Строка без читаемого id бесполезна как «дело, которое можно открыть», но важна как факт
    // «приглашение уже есть»: выбросив её, мы пригласили бы второй раз.
    const c = client(ok([{ ID: '77', COMPLETED: 'N' }, { ID: 'abc', COMPLETED: 'N' }]))
    expect(await activityListByMarker(c, marker, 759)).toEqual([
      { id: 77, completed: false },
      { id: 0, completed: false }
    ])
  })

  it('пустой ответ портала → пусто, без падения', async () => {
    expect(await activityListByMarker(client(ok(null)), marker, 759)).toEqual([])
  })
})
