import { describe, it, expect } from 'vitest'
import {
  INVITATION_TOKEN_PARAM,
  STORED_TOKEN_TTL_MS,
  decideInvitationToken,
  hasInvitationTokenAttempt,
  parseStoredInvitation,
  readInvitationToken,
  surveyPath
} from '../src/client/invitation-link'
import { crmContextSchema } from '../src/domain/schema'
import { DEMO_INVITATION_CONTEXT, DEMO_INVITATION_CONTEXT_2 } from '../src/demo/seed'

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

describe('демо-приглашения показывают то, ради чего заведены', () => {
  it('контекст РАЗБИРАЕТСЯ схемой — поле-призрак не проедет молча', () => {
    // ⚠️ Это не формальность. Первая редакция несла `dealTitle`, которого в `CrmContext` нет вовсе, и
    // typecheck её пропустил: spread в литерал не включает проверку лишних свойств, а zod молча
    // срезает неизвестные ключи. Демо при этом «работало», просто показывало не то.
    for (const context of [DEMO_INVITATION_CONTEXT, DEMO_INVITATION_CONTEXT_2]) {
      const parsed = crmContextSchema.safeParse(context)
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
      expect(parsed.data, 'схема срезала поля — значит их в контексте не существует').toEqual(context)
    }
  })

  it('несут ДЕНОРМАЛИЗОВАННЫЕ ИМЕНА — иначе срезы дашборда падают на голые ID', () => {
    for (const context of [DEMO_INVITATION_CONTEXT, DEMO_INVITATION_CONTEXT_2]) {
      expect(context.companyName, 'срез «клиент» показал бы ID').toBeTruthy()
      expect(context.dealCategoryName, 'срез «направление» показал бы ID').toBeTruthy()
      expect(context.responsibleName, 'срез «ответственный» показал бы ID').toBeTruthy()
    }
  })

  it('две демо-сделки РАЗНЫЕ — иначе правило «две ссылки = две сделки» не показать', () => {
    expect(DEMO_INVITATION_CONTEXT.dealId).not.toBe(DEMO_INVITATION_CONTEXT_2.dealId)
    expect(DEMO_INVITATION_CONTEXT.companyName).not.toBe(DEMO_INVITATION_CONTEXT_2.companyName)
  })
})

describe('испорченный токен отличается от отсутствующего', () => {
  it('дублированный параметр — это ПОПЫТКА передать токен, а не его отсутствие', () => {
    // Ревью показало последствие смешения: на `?token=a&token=b` клиент решал «токена нет»,
    // предпросмотр не делал и отправлял ответ БЕЗ привязки к сделке — молча. Сервер на тот же
    // запрос отвечает 400, то есть стороны понимали ссылку по-разному.
    expect(readInvitationToken(['a', 'b']), 'прочитать нельзя').toBeUndefined()
    expect(hasInvitationTokenAttempt(['a', 'b']), 'но попытка была').toBe(true)
  })

  it('токена нет вовсе — попытки тоже нет', () => {
    expect(hasInvitationTokenAttempt(undefined)).toBe(false)
    expect(hasInvitationTokenAttempt('')).toBe(false)
    expect(hasInvitationTokenAttempt('   ')).toBe(false)
    expect(hasInvitationTokenAttempt([])).toBe(false)
  })

  it('нормальный токен — и читается, и считается попыткой', () => {
    expect(readInvitationToken('tok-1')).toBe('tok-1')
    expect(hasInvitationTokenAttempt('tok-1')).toBe(true)
  })
})

describe('какой токен уходит с ответом (правило старшинства)', () => {
  const NOW = 1_800_000_000_000
  const stored = (token: string, ageMs = 0) => ({ token, savedAt: NOW - ageMs })
  const decide = (over: Partial<Parameters<typeof decideInvitationToken>[0]>) =>
    decideInvitationToken({ hasDraft: false, nowMs: NOW, ...over })

  // Пять комбинаций «токен в адресе × сохранённая привязка» — вся матрица целиком. До выноса
  // правила в ядро под гейтом была ОДНА из них (сценарий визуального теста), потому что `app/**`
  // не покрывается ни `pnpm test`, ни порогом покрытия.
  it('адреса нет, привязки нет → ответ уходит без привязки', () => {
    expect(decide({})).toEqual({ token: undefined, clearDraft: false, save: false })
  })

  it('токен из адреса, привязки не было → берём и запоминаем', () => {
    expect(decide({ urlToken: 'A' })).toEqual({ token: 'A', clearDraft: false, save: true })
  })

  it('токен из адреса совпал с сохранённым → черновик цел, отсчёт TTL обновляется', () => {
    // `save: true` и на совпадении — это не лишняя запись, а продление: человек ПРИШЁЛ по ссылке
    // снова, значит сутки считаются от этого визита, а не от первого.
    expect(decide({ urlToken: 'A', stored: stored('A'), hasDraft: true }))
      .toEqual({ token: 'A', clearDraft: false, save: true })
  })

  it('токен из адреса ДРУГОЙ → он старше, а чужой черновик сбрасывается', () => {
    // Два приглашения — две разные сделки. Перенести ответы значит привязать оценку к чужой сделке.
    expect(decide({ urlToken: 'B', stored: stored('A'), hasDraft: true }))
      .toEqual({ token: 'B', clearDraft: true, save: true })
  })

  it('токена в адресе нет, но есть свежая привязка с черновиком → доигрываем по ней', () => {
    expect(decide({ stored: stored('A', 60_000), hasDraft: true }))
      .toEqual({ token: 'A', clearDraft: false, save: false })
  })

  it('токена в адресе нет и черновика нет → привязка забывается, а не наследуется', () => {
    // Общий компьютер: один открыл ссылку и ушёл, следующий заходит на голый /s/:key. Раньше он
    // молча наследовал чужой токен — ответ уезжал в чужую сделку, а чужое приглашение сгорало.
    expect(decide({ stored: stored('A'), hasDraft: false }))
      .toEqual({ token: undefined, clearDraft: true, save: false })
  })

  it('привязка старше суток → забывается вместе с черновиком', () => {
    expect(decide({ stored: stored('A', STORED_TOKEN_TTL_MS), hasDraft: true }))
      .toEqual({ token: undefined, clearDraft: true, save: false })
    // Ровно на границе — уже протухла; за миллисекунду до неё — ещё жива.
    expect(decide({ stored: stored('A', STORED_TOKEN_TTL_MS - 1), hasDraft: true }).token).toBe('A')
  })

  it('часы уехали вперёд (savedAt в будущем) → привязка живёт, а не умирает', () => {
    // Отрицательный возраст — это сдвиг часов, а не подделка: наказывать за него человека нечем.
    expect(decide({ stored: stored('A', -60_000), hasDraft: true }).token).toBe('A')
  })
})

describe('запись о токене в браузере: разбор', () => {
  it('полная запись читается', () => {
    expect(parseStoredInvitation({ token: 'A', savedAt: 17 })).toEqual({ token: 'A', savedAt: 17 })
  })

  it('пробелы вокруг токена срезаются', () => {
    expect(parseStoredInvitation({ token: ' A ', savedAt: 17 })?.token).toBe('A')
  })

  it('всё неполное и бессмысленное → «записи нет»', () => {
    // Данные недоверенные: их правит кто угодно через консоль браузера. Подсунутый `savedAt` не
    // числом дал бы вечную привязку (сравнение с ним ложно в обе стороны), поэтому форма
    // проверяется целиком, а не приводится.
    for (const raw of [
      undefined, null, 42, 'A', [], { token: 'A' }, { savedAt: 17 },
      { token: '', savedAt: 17 }, { token: '   ', savedAt: 17 },
      { token: 'A', savedAt: 'вчера' }, { token: 'A', savedAt: NaN }, { token: 'A', savedAt: Infinity }
    ]) {
      expect(parseStoredInvitation(raw), JSON.stringify(raw) ?? 'undefined').toBeUndefined()
    }
  })

  it('испорченная запись = записи нет: привязка не наследуется', () => {
    const d = decideInvitationToken({
      urlToken: undefined,
      stored: parseStoredInvitation({ token: 'A', savedAt: 'вчера' }),
      hasDraft: true,
      nowMs: 1
    })
    expect(d.token).toBeUndefined()
  })
})
