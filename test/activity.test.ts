import { describe, expect, it, vi } from 'vitest'
import {
  buildSurveyInviteActivity,
  activityConfigurableAdd,
  dealDetailPath,
  DEAL_OWNER_TYPE_ID,
  SURVEY_ACTIVITY_LOGO,
  type SurveyInviteActivityInput
} from '../src/bitrix24/activity'
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
})

describe('activityConfigurableAdd — REST-обёртка', () => {
  it('зовёт crm.activity.configurable.add с параметрами билдера → id активности', async () => {
    const c = client(ok(9012))
    const params = buildSurveyInviteActivity(input())
    const id = await activityConfigurableAdd(c, params)
    expect(id).toBe(9012)
    expect(c.calls[0]).toEqual(['crm.activity.configurable.add', params])
  })
})
