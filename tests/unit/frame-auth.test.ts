import { describe, expect, it, vi } from 'vitest'
import { verifyDealAccess, verifyFrameToken } from '../../server/b24/frame-auth'

/**
 * Проверка фреймового пропуска — граница безопасности всех портальных экранов: за ней
 * начинается работа НАШИМ токеном, у которого прав больше, чем у любого сотрудника.
 * Соседний по устройству `server/b24/oauth.ts` тестами закрыт с самого начала, а этот файл
 * приехал без единого теста — заметила панель ревью PR #18.
 *
 * Держим четыре класса отказов, каждый из которых уже случался в реальных интеграциях:
 * «не пущу» спутано с «портал лежит», токен уехал в адрес, вопрос о доступе задан не тем
 * токеном, и ответ портала принят на веру без разбора.
 */

const DOMAIN = 'shef.bitrix24.ru'
const FRAME_TOKEN = 'фреймовый-токен-сотрудника'

/** Ответ портала с настоящим кодом HTTP: именно по нему различаются отказ и недоступность. */
function answering(body: unknown, status = 200) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch
}

function callsOf(fetchFn: typeof fetch) {
  return (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls
}

describe('подтверждение фреймового токена', () => {
  it('спрашивает `profile`, а не `user.current`', async () => {
    // `user.current` требует скоуп `user, user_brief, user_basic`, которого приложение
    // не запрашивает вовсе. На живом портале такая проверка просто не работала бы.
    const fetchFn = answering({ result: { ID: '17' } })
    await verifyFrameToken(DOMAIN, FRAME_TOKEN, fetchFn)

    expect(String(callsOf(fetchFn)[0]![0])).toBe(`https://${DOMAIN}/rest/profile`)
  })

  it('возвращает идентификатор сотрудника, приведённый к числу', async () => {
    // Портал отдаёт `ID` строкой. Без приведения он уезжает в журнал строкой,
    // а сравнение с числом молча даёт ложь.
    const outcome = await verifyFrameToken(DOMAIN, FRAME_TOKEN, answering({ result: { ID: '17' } }))

    expect(outcome).toEqual({ ok: true, userId: 17, userName: '' })
  })

  it('заодно приносит имя сотрудника — им подписана шапка анкеты', async () => {
    // ⚠ Имя берётся ЗДЕСЬ не ради удобства, а потому что взять его больше неоткуда:
    // `user.get` требует скоуп `user`/`user_brief`, которого приложение не запрашивает.
    // `profile` отдаёт `NAME`/`LAST_NAME` вместе с `ID`, и этот вызов мы делаем и так —
    // то есть имя не стоит ни одного лишнего обращения к порталу.
    const outcome = await verifyFrameToken(
      DOMAIN,
      FRAME_TOKEN,
      answering({ result: { ID: 17, NAME: ' Мария ', LAST_NAME: 'Ковалёва' } }),
    )

    expect(outcome).toEqual({ ok: true, userId: 17, userName: 'Мария Ковалёва' })
  })

  it('незаполненное имя — пустая строка, а не «undefined undefined»', async () => {
    // Такое уезжало бы в шапку анкеты постороннему человеку.
    const only = await verifyFrameToken(DOMAIN, FRAME_TOKEN, answering({ result: { ID: 17, NAME: 'Мария' } }))
    const none = await verifyFrameToken(DOMAIN, FRAME_TOKEN, answering({ result: { ID: 17 } }))

    expect(only).toMatchObject({ userName: 'Мария' })
    expect(none).toMatchObject({ userName: '' })
  })

  it('не отправляет токен в адресе — только телом', async () => {
    // Адрес оседает в access-логе прокси, тело — нигде. Документация портала показывает
    // и форму с `?auth=` в query; здесь сознательно иначе.
    const fetchFn = answering({ result: { ID: 1 } })
    await verifyFrameToken(DOMAIN, FRAME_TOKEN, fetchFn)

    const [url, init] = callsOf(fetchFn)[0]!
    expect(String(url)).not.toContain(FRAME_TOKEN)
    expect(JSON.parse(String((init as { body: string }).body))).toEqual({ auth: FRAME_TOKEN })
  })

  it('различает отказ портала и недоступность портала', async () => {
    // Свалить их в одно значит объявлять сотрудника самозванцем каждый раз, когда
    // у портала плохой день, — и это невозможно отличить от настоящей подделки.
    const refused = await verifyFrameToken(DOMAIN, FRAME_TOKEN, answering({ error: 'expired_token' }, 401))
    const down = await verifyFrameToken(DOMAIN, FRAME_TOKEN, answering({ error: 'INTERNAL' }, 500))

    expect(refused).toEqual({ ok: false, reason: 'rejected' })
    expect(down).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('считает недоступностью и оборванную связь, а не только 5xx', async () => {
    const dead = vi.fn(async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch

    await expect(verifyFrameToken(DOMAIN, FRAME_TOKEN, dead)).resolves.toEqual(
      { ok: false, reason: 'unreachable' },
    )
  })

  it('не верит ответу `200` без годного идентификатора', async () => {
    // Портал отвечает двухсотым и на часть ошибок, кладя `error` в тело. Принять такой
    // ответ за подтверждение значит пустить кого угодно.
    for (const body of [{ error: 'NO_AUTH_FOUND' }, { result: {} }, { result: { ID: 0 } }, null]) {
      expect(await verifyFrameToken(DOMAIN, FRAME_TOKEN, answering(body))).toEqual(
        { ok: false, reason: 'rejected' },
      )
    }
  })

  it('не ходит в сеть с пустым доменом или пустым токеном', async () => {
    const fetchFn = answering({ result: { ID: 1 } })

    expect(await verifyFrameToken('', FRAME_TOKEN, fetchFn)).toEqual({ ok: false, reason: 'rejected' })
    expect(await verifyFrameToken(DOMAIN, '   ', fetchFn)).toEqual({ ok: false, reason: 'rejected' })
    expect(callsOf(fetchFn)).toHaveLength(0)
  })
})

describe('проверка доступа к сделке', () => {
  it('спрашивает `crm.deal.get` ТОКЕНОМ СОТРУДНИКА', async () => {
    // Весь смысл проверки. Спросив своим токеном, приложение подтвердит доступ всегда —
    // у него прав больше, — и станет подставным лицом: менеджер подставит в запрос номер
    // чужой сделки и получит на неё рабочую ссылку.
    const fetchFn = answering({ result: { ID: 42 } })
    await verifyDealAccess(DOMAIN, FRAME_TOKEN, 42, fetchFn)

    const [url, init] = callsOf(fetchFn)[0]!
    expect(String(url)).toBe(`https://${DOMAIN}/rest/crm.deal.get`)
    expect(JSON.parse(String((init as { body: string }).body))).toEqual({ id: 42, auth: FRAME_TOKEN })
  })

  it('ходит на домен из НАШЕЙ записи, а не на тот, что в запросе', async () => {
    // Домен сюда передаёт вызывающий, взяв его из своей базы по `member_id`. Если он
    // когда-нибудь приедет из тела запроса, проверка превратится в SSRF: обращающийся
    // подставит свой адрес и получит «подтверждение» от собственного сервера.
    const fetchFn = answering({ result: { ID: 42 } })
    await verifyDealAccess(DOMAIN, FRAME_TOKEN, 42, fetchFn)

    expect(String(callsOf(fetchFn)[0]![0]).startsWith(`https://${DOMAIN}/`)).toBe(true)
  })

  it('отказ портала — это «не видит», а не «портал лежит»', async () => {
    // `crm.deal.get` на недоступную сделку отвечает четырёхсотым с `Access denied`
    // или `Not found`. Ни то, ни другое не повод пускать.
    const denied = await verifyDealAccess(DOMAIN, FRAME_TOKEN, 42, answering({ error: 'Access denied' }, 400))
    const missing = await verifyDealAccess(DOMAIN, FRAME_TOKEN, 42, answering({ error: 'Not found' }, 400))
    const down = await verifyDealAccess(DOMAIN, FRAME_TOKEN, 42, answering({ error: 'INTERNAL' }, 503))

    expect(denied).toEqual({ ok: false, reason: 'denied' })
    expect(missing).toEqual({ ok: false, reason: 'denied' })
    expect(down).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('не считает доступом двухсотый ответ без сделки в теле', async () => {
    for (const body of [{ result: null }, { result: {} }, { error: 'Not found' }]) {
      expect(await verifyDealAccess(DOMAIN, FRAME_TOKEN, 42, answering(body))).toEqual(
        { ok: false, reason: 'denied' },
      )
    }
  })
})
