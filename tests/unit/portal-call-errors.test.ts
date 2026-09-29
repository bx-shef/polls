import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AjaxError, RefreshTokenError } from '@bitrix24/b24jssdk'
import { asPortalError, makePortalCall } from '../../server/b24/client'
import { safeRefusal } from '../../server/domain/answers/portal-errors'
import { isDeadGrant } from '../../server/domain/portals/lifecycle'
import { isRetryableRefusal, refusalCode } from '../../server/domain/portals/portal-error'

/**
 * The boundary where the SDK's error becomes ours — driven against a real SDK and a real socket.
 *
 * ⚠ ЭТОТ ФАЙЛ СУЩЕСТВУЕТ ПОТОМУ, ЧТО ЕГО НЕ БЫЛО. Дефект «код отказа теряется между SDK
 * и классификатором» ловили ДВЕ панели ревью подряд, и оба раза весь `pnpm check` был зелёным.
 * Причина одна: ни один тест не проходил через настоящий `makePortalCall`. Все строили
 * `PortalError` руками — то есть проверяли наше представление о форме ошибки, а не форму.
 *
 * Первый раз оказалось, что `message` не содержит машинного кода (он в отдельном поле).
 * Второй — что SDK вообще БРОСАЕТ отказ, а не возвращает результатом, и ветка, где код
 * доставался, не достигалась. Третьего раза быть не должно, поэтому здесь поднимается
 * настоящий HTTP-сервер и настоящий клиент SDK: подделывать нечего.
 *
 * ⚠ Сервер локальный и отвечает мгновенно; сети наружу тест не трогает. TLS настоящий,
 * потому что `makePortalCall` строит адрес портала по `https://` — подменить схему значило
 * бы проверять не тот путь. Сертификат самоподписанный, выпускается на время теста,
 * и проверка цепочки в ЭТОМ воркере отключается с возвратом прежнего значения.
 */

/** Что отвечает «портал» на следующий вызов. Меняется сценарием. */
let reply: { status: number, body: unknown } = { status: 200, body: { result: true } }
/** Оборвать соединение вместо ответа — так выглядит беда связи для клиента. */
let dropConnection = false
/** Что отвечает «сервер авторизации» на продление. */
let authReply: { status: number, body: unknown } = { status: 200, body: { result: true } }

let server: Server
let port = 0
let certDir = ''
let previousTlsSetting: string | undefined

beforeAll(async () => {
  certDir = mkdtempSync(join(tmpdir(), 'polls-tls-'))
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1',
    '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'),
  ], { stdio: 'ignore' })

  previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

  server = createServer({
    key: readFileSync(join(certDir, 'key.pem')),
    cert: readFileSync(join(certDir, 'cert.pem')),
  }, (req, res) => {
    let raw = ''
    req.on('data', chunk => (raw += chunk))
    req.on('end', () => {
      const isAuth = (req.url ?? '').includes('token') || (req.url ?? '').includes('oauth')
      if (dropConnection && !isAuth) {
        req.socket.destroy()
        return
      }
      const { status, body } = isAuth ? authReply : reply
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})

afterAll(() => {
  server.close()
  rmSync(certDir, { recursive: true, force: true })
  if (previousTlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsSetting
})

/** Клиент, смотрящий на наш сервер. `expiresIn` отрицательный — SDK пойдёт продлевать. */
function portalTo(expiresIn = 3600) {
  return makePortalCall({
    memberId: 'm1',
    domain: `127.0.0.1:${port}`,
    accessToken: 'доступ',
    refreshToken: 'обновление',
    applicationToken: '',
    expiresIn,
    scope: ['crm'],
  })
}

/** Одиночный вызов того же клиента — им пользуется большинство проверок ниже. */
function callTo(expiresIn = 3600) {
  return portalTo(expiresIn).call
}

async function refusalOf(call: ReturnType<typeof callTo>): Promise<unknown> {
  try {
    await call('crm.item.update', {})
    throw new Error('вызов не отказал, хотя должен был')
  }
  catch (error) {
    return error
  }
}

describe('отказ портала доезжает до нас с машинным кодом', () => {
  it('обычный отказ метода: код сохраняется', async () => {
    // ⚠ Именно так SDK и доставляет отказ REST-метода — ИСКЛЮЧЕНИЕМ, а не результатом.
    // Первая редакция `makePortalCall` разбирала только результат, и эта ветка молчала.
    reply = { status: 400, body: { error: 'ACCESS_DENIED', error_description: 'Доступ запрещен' } }

    const error = await refusalOf(callTo())

    expect(refusalCode(error)).toBe('ACCESS_DENIED')
    expect(safeRefusal(error)).toBe('ACCESS_DENIED')
    expect(isDeadGrant(error)).toBe(false)
  })

  it('мёртвый грант: код достаётся из-под обёртки SDK', async () => {
    // ⚠ Самый важный тест файла и единственная причина, по которой механизм отмирания портала
    // вообще работает. Отказ сервера авторизации SDK заворачивает в собственный
    // `JSSDK_UNKNOWN_ERROR`, пряча настоящий код в `originalError`. Не развернув его,
    // мы не отличили бы ушедшего клиента ни от чего другого — и не отличали, две редакции.
    //
    // ⚠ Этот случай прогнать насквозь нельзя: продление уходит на `oauth.bitrix.info`,
    // адрес зашит константой, и перенаправить его на заглушку нечем. Поэтому обёртка
    // собирается из НАСТОЯЩИХ классов SDK — не из самодельного объекта. Сама вложенность
    // (`AjaxError` с кодом `JSSDK_UNKNOWN_ERROR`, внутри `RefreshTokenError` с настоящим
    // кодом) снята зондом с живого SDK 2.2.0 против локального сервера авторизации;
    // протокол зонда — в `docs/PROCESS.md`.
    const inner = new RefreshTokenError({
      code: 'invalid_grant',
      description: 'Переданы некорректные авторизационные данные',
    } as never)
    const wrapped = new AjaxError({
      code: 'JSSDK_UNKNOWN_ERROR',
      description: 'Переданы некорректные авторизационные данные',
      originalError: inner,
      requestInfo: { method: 'crm.item.update' },
    } as never)

    const error = asPortalError(wrapped)

    expect(refusalCode(error)).toBe('invalid_grant')
    expect(isDeadGrant(error)).toBe(true)
  })

  it('код транспорта наружу как код отказа не выдаётся', () => {
    // ⚠ Обратная сторона разворачивания: у обычного отказа метода во внутренней ошибке лежит
    // код axios (`ERR_BAD_REQUEST`). Взяв внутренний код всегда, мы подменили бы код портала
    // кодом транспорта — я так и написал в первой редакции, и поймал это первый же прогон
    // теста выше.
    const axiosLike = Object.assign(new Error('Request failed'), { code: 'ERR_BAD_REQUEST' })
    const wrapped = new AjaxError({
      code: 'ACCESS_DENIED',
      description: 'Доступ запрещен',
      originalError: axiosLike,
      requestInfo: { method: 'crm.item.update' },
    } as never)

    expect(refusalCode(asPortalError(wrapped))).toBe('ACCESS_DENIED')
  })

  it('внутренний код SDK наружу как код отказа не выдаётся', async () => {
    // `JSSDK_*` — это про SDK, а не про портал. Ни объяснить человеку, ни принять решение
    // по нему нельзя, поэтому он приравнивается к «кода нет».
    reply = { status: 500, body: 'не json' }
    authReply = { status: 200, body: { result: true } }

    const error = await refusalOf(callTo())

    expect(refusalCode(error)).not.toMatch(/^JSSDK_/)
    expect(isDeadGrant(error)).toBe(false)
  })

  it('успешный вызов возвращает данные, а не бросает', async () => {
    // Гвард под обёртку: перехватывая исключения, легко проглотить и удачу.
    reply = { status: 200, body: { result: { item: { id: 7 } }, time: { start: 1, finish: 2, duration: 1 } } }
    authReply = { status: 200, body: { result: true } }

    await expect(callTo()('crm.item.get', {})).resolves.toMatchObject({ result: { item: { id: 7 } } })
  })
})

/**
 * Пакет — против настоящего SDK и настоящего конверта портала.
 *
 * ⚠ Тем же приёмом и по той же причине, что весь файл: форма ответа `batch` у Битрикс24
 * своя (`result.result` рядом с `result.result_error`), и подделка проверяла бы наше
 * представление о ней, а не её саму. Тела ответов ниже — дословные по форме с живого
 * портала (проверено 23.09 вебхуком на `crm.item.get`).
 */
/**
 * Беда связи и отказ без кода — по статусу ответа, а не по имени кода (issue #99).
 *
 * ⚠ Обе ошибки прежде путались в обратную сторону. Сетевой код SDK (`ECONNRESET`) доезжал до
 * `PortalError.code`, и разрыв связи на разовом шаге обустройства отмечал ревизию навсегда.
 * А отказ проверки с пустым кодом SDK сводит к `ERR_BAD_REQUEST`, и он считался повторимым:
 * портал проходил обустройство целиком каждый час вечно. Нашёл `/review` в панели PR #98.
 * Формы ошибок сняты зондом против SDK 2.2.0 и этого же сервера (29.09).
 */
describe('беда связи и отказ без кода', () => {
  afterEach(() => {
    dropConnection = false
  })

  it('ГЛАВНОЕ: связь оборвалась — отказ без кода, и его повторяют', async () => {
    dropConnection = true

    const error = await refusalOf(callTo())

    expect(refusalCode(error)).toBe('')
    expect(isRetryableRefusal(error)).toBe(true)
    expect(isDeadGrant(error)).toBe(false)
  })

  it.each<[string, number, unknown]>([
    ['пустой код', 400, { error: '', error_description: 'Section at index 0 does not have title.' }],
    ['код «0»', 400, { error: '0', error_description: 'Нельзя изменить закрытое дело' }],
    ['«Not found» без кода', 404, { error: '', error_description: 'Not found' }],
  ])('ГЛАВНОЕ: портал отказал без кода (%s) — SHEF_REJECTED, и его не повторяют', async (_name, status, body) => {
    reply = { status, body }

    const error = await refusalOf(callTo())

    expect(refusalCode(error)).toBe('SHEF_REJECTED')
    expect(isRetryableRefusal(error)).toBe(false)
    // Код свой, и `safeRefusal` его называет — в журнал уходит он, а не проза портала.
    expect(safeRefusal(error)).toBe('SHEF_REJECTED')
  })

  it('429 без тела — повторимый: его лечит время, а не правка запроса', async () => {
    reply = { status: 429, body: 'не json' }

    const error = await refusalOf(callTo())

    expect(refusalCode(error)).toBe('')
    expect(isRetryableRefusal(error)).toBe(true)
  })

  it('предел с кодом портала — код сохраняется, и его повторяют', async () => {
    reply = { status: 429, body: { error: 'OPERATION_TIME_LIMIT', error_description: 'Method is blocked due to operation time limit' } }

    const error = await refusalOf(callTo())

    expect(refusalCode(error)).toBe('OPERATION_TIME_LIMIT')
    expect(isRetryableRefusal(error)).toBe(true)
  })

  it('ГЛАВНОЕ: сеть оборвалась при продлении токена — беда связи, а не мёртвый грант', () => {
    // Продление SDK заворачивает сетевой сбой в `RefreshTokenError` с кодом axios и статусом 0,
    // а тот — в `JSSDK_UNKNOWN_ERROR` (`dist/esm/oauth/auth.mjs`). Классы — настоящие, как у мёртвого гранта.
    const inner = new RefreshTokenError({ code: 'ECONNRESET', description: 'socket hang up', status: 0 } as never)
    const wrapped = new AjaxError({
      code: 'JSSDK_UNKNOWN_ERROR',
      description: 'socket hang up',
      status: 0,
      originalError: inner,
      requestInfo: { method: 'crm.item.update' },
    } as never)

    const error = asPortalError(wrapped)

    expect(refusalCode(error)).toBe('')
    expect(isRetryableRefusal(error)).toBe(true)
    expect(isDeadGrant(error)).toBe(false)
  })

  it('ГЛАВНОЕ: мёртвый грант со статусом ответа сервера авторизации — по-прежнему мёртвый', () => {
    // Сервер авторизации ОТВЕТИЛ, и статус у вложенной ошибки настоящий. Статус 0 — только у беды связи.
    const inner = new RefreshTokenError({ code: 'invalid_grant', description: 'Переданы некорректные авторизационные данные', status: 400 } as never)
    const wrapped = new AjaxError({
      code: 'JSSDK_UNKNOWN_ERROR',
      description: 'Переданы некорректные авторизационные данные',
      status: 0,
      originalError: inner,
      requestInfo: { method: 'crm.item.update' },
    } as never)

    expect(isDeadGrant(asPortalError(wrapped))).toBe(true)
  })

  it('таймаут самого SDK — беда связи', () => {
    const timedOut = new AjaxError({
      code: 'REQUEST_TIMEOUT',
      description: 'Request timeout exceeded',
      status: 408,
      requestInfo: { method: 'crm.item.update' },
    } as never)

    expect(refusalCode(asPortalError(timedOut))).toBe('')
    expect(isRetryableRefusal(asPortalError(timedOut))).toBe(true)
  })
})

describe('пакетный вызов', () => {
  /** Конверт v2 в том виде, в каком его отдаёт портал. */
  function envelope(result: Record<string, unknown>, resultError: Record<string, unknown> = {}) {
    const time = { start: 1, finish: 2, duration: 1, processing: 1, date_start: 'x', date_finish: 'y' }
    return {
      status: 200,
      body: {
        result: {
          result,
          result_error: resultError,
          result_total: {},
          result_next: {},
          result_time: Object.fromEntries(Object.keys(result).map(key => [key, time])),
        },
        time,
      },
    }
  }

  it('отдаёт результаты команд по их именам', async () => {
    reply = envelope({
      deal: { item: { id: 2, title: 'Test' } },
      company: { item: { id: 2, title: 'Рога и копыта' } },
    })
    authReply = { status: 200, body: { result: true } }

    const data = await portalTo().batch({
      deal: { method: 'crm.item.get', params: { entityTypeId: 2, id: 2 } },
      company: { method: 'crm.item.get', params: { entityTypeId: 4, id: '$result[deal][item][companyId]' } },
    })

    expect(data).toMatchObject({ company: { item: { title: 'Рога и копыта' } } })
  })

  it('упавшая команда не уносит остальные и НЕ бросает', async () => {
    // ⚠ ГЛАВНЫЙ ГВАРД. На этом держится вся шапка анкеты: у сделки может не быть компании,
    // и тогда её команда приезжает `NOT_FOUND`. Если бы отказ одной команды рушил пакет,
    // выпуск ссылки падал бы на каждой сделке без компании — то есть на половине.
    reply = envelope(
      { deal: { item: { id: 2, title: 'Test' } } },
      { company: { error: 'NOT_FOUND', error_description: 'Элемент не найден' } },
    )
    authReply = { status: 200, body: { result: true } }

    const data = await portalTo().batch({
      deal: { method: 'crm.item.get', params: { entityTypeId: 2, id: 2 } },
      company: { method: 'crm.item.get', params: { entityTypeId: 4, id: 0 } },
    })

    // Успешная — на месте; упавшей просто нет, и это единственный признак отказа,
    // на который вызывающий может опереться.
    expect(data.deal).toMatchObject({ item: { title: 'Test' } })
    expect(data).not.toHaveProperty('company')
  })

  it('отказ всего пакета бросается кодом портала, как и одиночный вызов', async () => {
    // Мёртвый грант, отобранные права, недоступный портал — это не «команда не отработала»,
    // а «разговора не было». Молча вернуть пустую карту здесь значило бы выдать отказ
    // портала за «у сделки ничего не заполнено».
    reply = { status: 400, body: { error: 'ACCESS_DENIED', error_description: 'Доступ запрещен' } }
    authReply = { status: 200, body: { result: true } }

    const failed = portalTo().batch({ deal: { method: 'crm.item.get', params: { id: 1 } } })

    await expect(failed).rejects.toSatisfy(error => refusalCode(error) === 'ACCESS_DENIED')
  })
})
