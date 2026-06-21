import { describe, expect, it, vi } from 'vitest'
import {
  parseInstallEvent,
  installToTokens,
  installToB24Params,
  surveyRobotParams,
  surveyPlacements,
  parsePlacementDealId,
  parsePlacementTaskId,
  handleInstall,
  SURVEY_ROBOT_CODE,
  PLACEMENT_DEAL_ACTIVITY,
  PLACEMENT_ANALYTICS_MENU,
  PLACEMENT_TASK_VIEW
} from '../src/bitrix24/install'
import type { OAuthTokens } from '../src/bitrix24/oauth'

const validRaw = {
  event: 'ONAPPINSTALL',
  auth: {
    access_token: 'AT-1',
    refresh_token: 'RT-1',
    expires_in: '3600',
    member_id: 'm-abc',
    domain: 'acme.bitrix24.ru',
    application_token: 'app-tok-xyz',
    client_endpoint: 'https://acme.bitrix24.ru/rest/'
  }
}

describe('parseInstallEvent — event-формат ONAPPINSTALL (#17)', () => {
  it('валидный POST → нормализованный InstallAuth', () => {
    const e = parseInstallEvent(validRaw)
    expect(e?.memberId).toBe('m-abc')
    expect(e?.expiresIn).toBe(3600)
    expect(e?.applicationToken).toBe('app-tok-xyz')
    expect(e?.accessToken).toBe('AT-1')
  })
  it('нет токена/мусор → null', () => {
    expect(parseInstallEvent({ auth: { ...validRaw.auth, access_token: '' } })).toBeNull()
    expect(parseInstallEvent({ auth: undefined })).toBeNull()
    expect(parseInstallEvent('garbage')).toBeNull()
  })
})

describe('parseInstallEvent — install-страница (плоские поля) (#17)', () => {
  it('AUTH_ID/REFRESH_ID/DOMAIN/member_id → InstallAuth (app_token опционален)', () => {
    const e = parseInstallEvent({
      DOMAIN: 'acme.bitrix24.ru',
      AUTH_ID: 'AT-page',
      REFRESH_ID: 'RT-page',
      AUTH_EXPIRES: '3600',
      member_id: 'm-page',
      status: 'L'
    })
    expect(e).toMatchObject({ accessToken: 'AT-page', refreshToken: 'RT-page', memberId: 'm-page', domain: 'acme.bitrix24.ru', expiresIn: 3600 })
    expect(e?.applicationToken).toBeUndefined() // install-страница его не шлёт
  })
  it('AUTH_EXPIRES отсутствует → дефолт 3600', () => {
    const e = parseInstallEvent({ DOMAIN: 'a.bitrix24.ru', AUTH_ID: 'x', REFRESH_ID: 'y', member_id: 'm' })
    expect(e?.expiresIn).toBe(3600)
  })
})

describe('installToTokens (#17)', () => {
  it('маппит в OAuthTokens + applicationToken; expiresAt из expires_in', () => {
    const now = new Date('2026-06-20T10:00:00.000Z')
    const t = installToTokens(parseInstallEvent(validRaw)!, now)
    expect(t).toMatchObject({
      memberId: 'm-abc',
      accessToken: 'AT-1',
      refreshToken: 'RT-1',
      domain: 'acme.bitrix24.ru',
      applicationToken: 'app-tok-xyz'
    })
    expect(t.expiresAt).toBe('2026-06-20T11:00:00.000Z') // now + 3600s
  })
})

describe('installToB24Params (#17)', () => {
  it('полный auth → B24OAuthParams', () => {
    const ev = parseInstallEvent({
      auth: { ...validRaw.auth, user_id: '1', scope: 'crm,bizproc', status: 'L', server_endpoint: 'https://oauth.bitrix.info/rest/' }
    })!
    const p = installToB24Params(ev)
    expect(p).toMatchObject({
      memberId: 'm-abc',
      accessToken: 'AT-1',
      refreshToken: 'RT-1',
      applicationToken: 'app-tok-xyz',
      userId: 1,
      scope: 'crm,bizproc',
      status: 'L'
    })
  })
  it('минимальный auth → дефолты (clientEndpoint/serverEndpoint/status/userId)', () => {
    const p = installToB24Params(parseInstallEvent(validRaw)!, new Date('2026-06-20T10:00:00.000Z'))
    expect(p.clientEndpoint).toBe('https://acme.bitrix24.ru/rest/')
    expect(p.serverEndpoint).toBe('https://oauth.bitrix.info/rest/')
    expect(p.status).toBe('L')
    expect(p.userId).toBe(0)
    expect(p.expires).toBe(Math.floor(new Date('2026-06-20T10:00:00.000Z').getTime() / 1000) + 3600)
  })
})

describe('surveyRobotParams (#17)', () => {
  it('робот на сделках с нашим HANDLER и стабильным CODE', () => {
    const p = surveyRobotParams('https://polls.bx-shef.by/api/b24/robot')
    expect(p.CODE).toBe(SURVEY_ROBOT_CODE)
    expect(p.HANDLER).toBe('https://polls.bx-shef.by/api/b24/robot')
    expect(p.DOCUMENT_TYPE).toEqual(['crm', 'CCrmDocumentDeal', 'DEAL'])
    expect(p.USE_SUBSCRIPTION).toBe('N')
  })
})

describe('surveyPlacements (#17)', () => {
  it('виджеты сделки + задачи + дашборд в аналитике, HANDLER на нашем домене', () => {
    const ps = surveyPlacements('https://polls.bx-shef.by/')
    expect(ps.map((p) => p.PLACEMENT)).toEqual([PLACEMENT_DEAL_ACTIVITY, PLACEMENT_ANALYTICS_MENU, PLACEMENT_TASK_VIEW])
    // хвостовой слеш baseUrl убран, HANDLER абсолютный https
    expect(ps[0]!.HANDLER).toBe('https://polls.bx-shef.by/b24/deal-widget')
    expect(ps[1]!.HANDLER).toBe('https://polls.bx-shef.by/b24/dashboard')
    expect(ps[2]!.HANDLER).toBe('https://polls.bx-shef.by/b24/task-widget')
    expect(ps[0]!.LANG_ALL?.ru?.TITLE).toBe('Опрос по сделке')
    expect(ps[2]!.LANG_ALL?.ru?.TITLE).toBe('Опрос по задаче')
  })
})

describe('parsePlacementTaskId (задача)', () => {
  it('JSON-строка {"taskId":"812"} → 812', () => {
    expect(parsePlacementTaskId('{"taskId":"812"}')).toBe(812)
  })
  it('объект с TASK_ID / ID → число', () => {
    expect(parsePlacementTaskId({ TASK_ID: 5 })).toBe(5)
    expect(parsePlacementTaskId({ ID: '9' })).toBe(9)
  })
  it('числовое значение в JSON (не строкой)', () => {
    expect(parsePlacementTaskId('{"taskId":812}')).toBe(812)
  })
  it('битый JSON / нет id / 0 / отрицательное / мусор → undefined', () => {
    expect(parsePlacementTaskId('{not json')).toBeUndefined()
    expect(parsePlacementTaskId('{"X":1}')).toBeUndefined()
    expect(parsePlacementTaskId('{"taskId":"0"}')).toBeUndefined()
    expect(parsePlacementTaskId('{"taskId":"-5"}')).toBeUndefined()
    expect(parsePlacementTaskId(null)).toBeUndefined()
    expect(parsePlacementTaskId(undefined)).toBeUndefined()
  })
})

describe('parsePlacementDealId (#17)', () => {
  it('JSON-строка {"ID":"3473"} → 3473', () => {
    expect(parsePlacementDealId('{"ID":"3473"}')).toBe(3473)
  })
  it('объект {ID:5} → 5', () => {
    expect(parsePlacementDealId({ ID: 5 })).toBe(5)
  })
  it('битый JSON / нет ID / 0 / мусор → undefined', () => {
    expect(parsePlacementDealId('{not json')).toBeUndefined()
    expect(parsePlacementDealId('{"X":1}')).toBeUndefined()
    expect(parsePlacementDealId('{"ID":"0"}')).toBeUndefined()
    expect(parsePlacementDealId(null)).toBeUndefined()
  })
})

describe('handleInstall — оркестрация (#17)', () => {
  it('сохраняет токены, ЗАТЕМ регистрирует встройки (порядок)', async () => {
    const order: string[] = []
    const saveTokens = vi.fn(async (_t: OAuthTokens) => {
      order.push('save')
    })
    const registerIntegrations = vi.fn(async (_t: OAuthTokens) => {
      order.push('register')
    })
    const tokens = await handleInstall(parseInstallEvent(validRaw)!, { saveTokens, registerIntegrations })
    expect(order).toEqual(['save', 'register']) // регистрация после сохранения
    expect(saveTokens).toHaveBeenCalledWith(expect.objectContaining({ memberId: 'm-abc', applicationToken: 'app-tok-xyz' }))
    expect(registerIntegrations).toHaveBeenCalledWith(tokens)
  })
})
