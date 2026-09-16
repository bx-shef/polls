import { describe, expect, it } from 'vitest'
import {
  buildSurveyUrl,
  createInvitation,
  DEFAULT_TTL_DAYS,
  type InvitationRequest,
} from '../../server/domain/invitations/invitation'
import { hashToken, isTokenShaped } from '../../server/domain/links/token'

/**
 * Выпуск приглашения. Сюда ведут три входа — кнопка в карточке, робот и событие смены стадии, —
 * поэтому ошибка здесь тиражируется на все три и всплывает у клиента, а не у нас.
 */

const NOW = new Date('2026-09-16T12:00:00Z')

const REQUEST: InvitationRequest = {}

describe('приглашение', () => {
  it('выпускает настоящий токен и его хеш', () => {
    const invitation = createInvitation(REQUEST, NOW)

    expect(isTokenShaped(invitation.token)).toBe(true)
    expect(invitation.tokenHash).toBe(hashToken(invitation.token))
  })

  it('не повторяет токен между выпусками', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => createInvitation(REQUEST, NOW).token))

    expect(tokens.size).toBe(200)
  })

  it('ставит срок в тридцать дней по умолчанию', () => {
    const invitation = createInvitation(REQUEST, NOW)

    expect(invitation.expiresAt.toISOString()).toBe('2026-10-16T12:00:00.000Z')
    expect(DEFAULT_TTL_DAYS).toBe(30)
  })

  it('слушается своего срока, когда он задан', () => {
    const invitation = createInvitation({ ...REQUEST, ttlDays: 3 }, NOW)

    expect(invitation.expiresAt.toISOString()).toBe('2026-09-19T12:00:00.000Z')
  })
})

describe('адрес анкеты', () => {
  it('строится от хоста портала', () => {
    expect(buildSurveyUrl('https://polls.bx-shef.by', 'ТОКЕН')).toBe('https://polls.bx-shef.by/s/ТОКЕН')
    expect(buildSurveyUrl('https://opros.example.com/', 'ТОКЕН')).toBe('https://opros.example.com/s/ТОКЕН')
  })

  it.each([[''], ['http://polls.bx-shef.by'], ['polls.bx-shef.by'], ['   ']])(
    'не строится по негодному хосту (%#)',
    (host) => {
      // `http` здесь означает токен доступа к чужой анкете, летящий открытым текстом
      // в письме. Лучше не выпустить ссылку, чем выпустить такую.
      expect(buildSurveyUrl(host, 'ТОКЕН')).toBeNull()
    },
  )
})
