import { describe, it, expect } from 'vitest'
import { INVITATION_TOKEN_PARAM, readInvitationToken, surveyPath } from '../src/client/invitation-link'

/**
 * Форма ссылки-приглашения — одна на две стороны: сервер её собирает, клиент читает. Пока читателя
 * не было, расхождение не проявлялось; с подключением токена к странице оно стало бы двухсторонним
 * и МОЛЧАЛИВЫМ — выписали с одним именем параметра, прочитали другое, ответ пишется без привязки к
 * сделке, и ничто этого не показывает.
 */
describe('ссылка-приглашение: сборка', () => {
  it('имя параметра запиннено литералом', () => {
    // Сверять с самим модулем бессмысленно — тест обязан знать ответ независимо. Смена имени
    // ломает уже выписанные ссылки у людей на руках, поэтому это осознанное изменение, а не правка.
    expect(INVITATION_TOKEN_PARAM).toBe('token')
  })

  it('путь без токена — обычная ссылка на опрос', () => {
    expect(surveyPath('csat_postdeal')).toBe('/s/csat_postdeal')
  })

  it('путь с токеном', () => {
    expect(surveyPath('csat_postdeal', 'tok-1')).toBe('/s/csat_postdeal?token=tok-1')
  })

  it('ключ и токен экранируются — иначе ссылка ломается или уводит не туда', () => {
    // Ключ приходит из конфигурации опроса, токен генерируется нами; но экранирование здесь не
    // «на всякий случай»: без него `&`/`#`/пробел в любом из них разрежут ссылку молча.
    expect(surveyPath('опрос/после сделки', 'a&b#c')).toBe(
      '/s/%D0%BE%D0%BF%D1%80%D0%BE%D1%81%2F%D0%BF%D0%BE%D1%81%D0%BB%D0%B5%20%D1%81%D0%B4%D0%B5%D0%BB%D0%BA%D0%B8?token=a%26b%23c'
    )
  })
})

describe('ссылка-приглашение: чтение', () => {
  it('обычный токен читается', () => {
    expect(readInvitationToken('tok-1')).toBe('tok-1')
  })

  it('массив отвергается ЦЕЛИКОМ, а не берётся первым элементом', () => {
    // `?token=a&token=b` даёт массив. Взять первый молча значило бы позволить отправителю ссылки
    // подсунуть второй токен, который увидит только код, но не человек.
    expect(readInvitationToken(['a', 'b'])).toBeUndefined()
    expect(readInvitationToken(['a'])).toBeUndefined()
  })

  it('пустое, пробельное и не-строка → «токена нет»', () => {
    // «Токена нет» и «токен пустой» для вызывающего одно и то же; отдельная ветка была бы разницей
    // без последствий.
    expect(readInvitationToken('')).toBeUndefined()
    expect(readInvitationToken('   ')).toBeUndefined()
    expect(readInvitationToken(undefined)).toBeUndefined()
    expect(readInvitationToken(null)).toBeUndefined()
    expect(readInvitationToken(42)).toBeUndefined()
  })

  it('окружающие пробелы срезаются', () => {
    // Копипаста ссылки из письма/мессенджера — обычное дело.
    expect(readInvitationToken('  tok-1  ')).toBe('tok-1')
  })

  it('сборка и чтение сходятся: то, что выписали, то и прочитали', () => {
    // Единственный тест, который ловит расхождение имени параметра между сторонами.
    const token = 'тк-1/особый&знак'
    const url = new URL(surveyPath('csat_postdeal', token), 'https://polls.example')
    expect(readInvitationToken(url.searchParams.get(INVITATION_TOKEN_PARAM))).toBe(token)
  })
})
