import { describe, expect, it, vi } from 'vitest'
import {
  parseInstallEvent,
  installToTokens,
  surveyRobotParams,
  handleInstall,
  SURVEY_ROBOT_CODE
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

describe('parseInstallEvent (#17)', () => {
  it('валидный POST → expires_in коэрсится, auth разобран', () => {
    const e = parseInstallEvent(validRaw)
    expect(e?.auth.member_id).toBe('m-abc')
    expect(e?.auth.expires_in).toBe(3600)
    expect(e?.auth.application_token).toBe('app-tok-xyz')
  })
  it('нет auth/токена/мусор → null', () => {
    expect(parseInstallEvent({ auth: { ...validRaw.auth, application_token: '' } })).toBeNull()
    expect(parseInstallEvent({ auth: undefined })).toBeNull()
    expect(parseInstallEvent('garbage')).toBeNull()
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

describe('surveyRobotParams (#17)', () => {
  it('робот на сделках с нашим HANDLER и стабильным CODE', () => {
    const p = surveyRobotParams('https://polls.bx-shef.by/api/b24/robot')
    expect(p.CODE).toBe(SURVEY_ROBOT_CODE)
    expect(p.HANDLER).toBe('https://polls.bx-shef.by/api/b24/robot')
    expect(p.DOCUMENT_TYPE).toEqual(['crm', 'CCrmDocumentDeal', 'DEAL'])
    expect(p.USE_SUBSCRIPTION).toBe('N')
  })
})

describe('handleInstall — оркестрация (#17)', () => {
  it('сохраняет токены, ЗАТЕМ регистрирует робот (порядок)', async () => {
    const order: string[] = []
    const saveTokens = vi.fn(async (_t: OAuthTokens) => {
      order.push('save')
    })
    const registerRobot = vi.fn(async (_t: OAuthTokens) => {
      order.push('robot')
    })
    const tokens = await handleInstall(parseInstallEvent(validRaw)!, { saveTokens, registerRobot })
    expect(order).toEqual(['save', 'robot']) // робот после сохранения
    expect(saveTokens).toHaveBeenCalledWith(expect.objectContaining({ memberId: 'm-abc', applicationToken: 'app-tok-xyz' }))
    expect(registerRobot).toHaveBeenCalledWith(tokens)
  })
})
