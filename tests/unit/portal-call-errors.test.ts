import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AjaxError, RefreshTokenError } from '@bitrix24/b24jssdk'
import { asPortalError, makePortalCall } from '../../server/b24/client'
import { safeRefusal } from '../../server/domain/answers/portal-errors'
import { isDeadGrant } from '../../server/domain/portals/lifecycle'
import { refusalCode } from '../../server/domain/portals/portal-error'

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
function callTo(expiresIn = 3600) {
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
