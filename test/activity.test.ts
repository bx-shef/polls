import { describe, expect, it, vi } from 'vitest'
import {
  buildSurveyInviteActivity,
  buildSurveyResultActivity,
  activityConfigurableAdd,
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
    const a = buildSurveyInviteActivity(input({ dealId: 7, surveyKey: 'k', token: 'tk' }))
    expect(Object.keys(a.layout.footer.buttons)).toEqual(['sendInvite']) // ≤2 кнопок футера
    expect(a.layout.footer.buttons.sendInvite).toEqual({
      title: 'Отправить приглашение',
      type: 'primary',
      action: { type: 'openRestApp', actionParams: { surveyKey: 'k', token: 'tk', dealId: 7 } }
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
    expect(Object.keys(a.layout.body.blocks).length).toBeLessThanOrEqual(20)
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
