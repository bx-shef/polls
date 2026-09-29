import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import process from 'node:process'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AjaxError, B24OAuth, RefreshTokenError } from '@bitrix24/b24jssdk'
import { asPortalError, makePortalCall } from '../../server/b24/client'
import { safeRefusal } from '../../server/domain/answers/portal-errors'
import { isDeadGrant } from '../../server/domain/portals/lifecycle'
import { isRetryableRefusal, PortalError, refusalCode } from '../../server/domain/portals/portal-error'
import { logger } from '../../server/utils/logger'

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

/**
 * Что отвечает «портал» на следующий вызов. Меняется сценарием.
 *
 * `raw` — тело как есть, не JSON: так отвечают прокси и WAF — страницей, а не телом портала.
 */
let reply: { status: number, body?: unknown, raw?: string, type?: string } = { status: 200, body: { result: true } }
/**
 * Как «портал» обходится с соединением: отвечает; рвёт его до ответа; молчит; рвёт посреди сжатого
 * тела — так выглядит обрыв, когда заголовки уже пришли и статус у ошибки настоящий (`/code-review`
 * в панели PR #106).
 */
let delivery: 'answer' | 'drop' | 'hang' | 'truncate' = 'answer'
/** Что отвечает «сервер авторизации» на продление. */
let authReply: { status: number, body?: unknown, raw?: string, type?: string } = { status: 200, body: { result: true } }
/** Оборвать соединение с «сервером авторизации» — беда связи посреди продления токена. */
let dropAuth = false

let server: Server
let port = 0
let certDir = ''
let previousTlsSetting: string | undefined
let previousNoProxy: string | undefined
/**
 * Сокеты, на которых «портал» молчит или оборвался посреди тела. Закрываются после теста.
 *
 * ⚠ Только они: простаивающие сокеты держит пул keep-alive клиента, и оборвав их, мы получили бы
 * в следующем тесте `ECONNRESET`, неотличимый от беды связи (тестировщик в панели PR #106).
 */
const inFlight = new Set<Socket>()
/** Сжатое тело побольше: половину его «портал» успевает отдать до обрыва. */
const GZIPPED = gzipSync(JSON.stringify({ result: { items: Array.from({ length: 2000 }, (_, i) => ({ id: i, title: `Элемент ${i}` })) } }))

beforeAll(async () => {
  certDir = mkdtempSync(join(tmpdir(), 'polls-tls-'))
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1',
    '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'),
  ], { stdio: 'ignore' })

  previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  // Прокси из окружения разработчика увёл бы и локальный сервер — и тесты беды связи мерили бы прокси.
  previousNoProxy = process.env.NO_PROXY
  process.env.NO_PROXY = '127.0.0.1'

  server = createServer({
    key: readFileSync(join(certDir, 'key.pem')),
    cert: readFileSync(join(certDir, 'cert.pem')),
  }, (req, res) => {
    let raw = ''
    req.on('data', chunk => (raw += chunk))
    req.on('end', () => {
      const isAuth = (req.url ?? '').includes('token') || (req.url ?? '').includes('oauth')
      if (isAuth ? dropAuth : delivery === 'drop') {
        req.socket.destroy()
        return
      }
      if (!isAuth && delivery === 'hang') {
        inFlight.add(req.socket)
        return
      }
      if (!isAuth && delivery === 'truncate') {
        res.writeHead(reply.status, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(GZIPPED.length) })
        res.write(GZIPPED.subarray(0, Math.floor(GZIPPED.length / 2)))
        inFlight.add(req.socket)
        setTimeout(() => req.socket.destroy(), 30)
        return
      }
      const { status, body, raw: rawBody, type } = isAuth ? authReply : reply
      res.writeHead(status, { 'content-type': type ?? 'application/json' })
      res.end(rawBody ?? JSON.stringify(body))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})

afterEach(() => {
  delivery = 'answer'
  dropAuth = false
  for (const socket of inFlight) socket.destroy()
  inFlight.clear()
  vi.useRealTimers()
})

afterAll(() => {
  if (previousNoProxy === undefined) delete process.env.NO_PROXY
  else process.env.NO_PROXY = previousNoProxy
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

/**
 * Отказ вызова — `PortalError`, иначе тест падает.
 *
 * ⚠ Своя ошибка «вызов не отказал» бросается ПОСЛЕ перехвата, а не внутри. Первая редакция бросала
 * её внутри `try`, сама же ловила и возвращала — а обычная `Error` без кода выглядит повторимой бедой
 * связи, и тесты «связь оборвалась» и «429 без тела» проходили бы, отвечай сервер хоть 200. Нашёл
 * тестировщик в панели PR #106. `PortalError`, а не сырая ошибка SDK: в той `originalError` с конфигом
 * запроса, то есть с токенами.
 */
async function rejectionOf(run: () => Promise<unknown>): Promise<PortalError> {
  let caught: unknown
  try {
    await run()
  }
  catch (error) {
    caught = error
  }
  if (caught === undefined) throw new Error('вызов не отказал, хотя должен был')
  expect(caught).toBeInstanceOf(PortalError)
  return caught as PortalError
}

/** Отказ одиночного вызова метода тем клиентом, что дан. */
function refusalOf(call: ReturnType<typeof callTo>): Promise<PortalError> {
  return rejectionOf(() => call('crm.item.update', {}))
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

  it.each([0, undefined])('мёртвый грант — при любом статусе вложенной ошибки (%s): сдвиг статуса в SDK его не спрячет', (status) => {
    // ⚠ Самый важный класс файла: признание мёртвого гранта — единственный способ узнать
    // об уходе клиента. Настоящий путь — насквозь через сокет — держит «продление токена» ниже;
    // здесь — что статус вложенной ошибки решения не меняет. SDK держим как `^2.2.0`, и сдвиг
    // статуса в минорной версии иначе молча превратил бы `invalid_grant` в беду связи
    // (безопасность в панели PR #106). Классы — настоящие.
    const inner = new RefreshTokenError({
      code: 'invalid_grant',
      description: 'Переданы некорректные авторизационные данные',
      status,
    } as never)
    const wrapped = new AjaxError({
      code: 'JSSDK_UNKNOWN_ERROR',
      description: 'Переданы некорректные авторизационные данные',
      status: 0,
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
    // Ошибка axios — в той форме, что кладёт SDK: признак, код, ответ со статусом и телом портала.
    const axiosLike = Object.assign(new Error('Request failed with status code 400'), {
      isAxiosError: true,
      code: 'ERR_BAD_REQUEST',
      response: { status: 400, data: { error: 'ACCESS_DENIED', error_description: 'Доступ запрещен' } },
    })
    const wrapped = new AjaxError({
      code: 'ACCESS_DENIED',
      description: 'Доступ запрещен',
      status: 400,
      originalError: axiosLike,
      requestInfo: { method: 'crm.item.update' },
    } as never)

    expect(refusalCode(asPortalError(wrapped))).toBe('ACCESS_DENIED')
  })

  it('отказ команды пакета, завёрнутый SDK в JSSDK_BATCH_SUB_ERROR, — код портала изнутри', () => {
    // Обычно SDK отдаёт ошибку команды как есть (`base-error`), а заворачивает — когда её нет
    // (`_createErrorFromAjaxResult` в `interface-strategy.mjs`). Классы — настоящие.
    const command = new AjaxError({ code: 'NOT_FOUND', description: 'Элемент не найден', status: 200, requestInfo: { method: 'crm.item.get' } } as never)
    const wrapped = new AjaxError({ code: 'JSSDK_BATCH_SUB_ERROR', description: 'Элемент не найден', status: 200, originalError: command, requestInfo: { method: 'crm.item.get' } } as never)

    expect(refusalCode(asPortalError(wrapped))).toBe('NOT_FOUND')
  })

  it('уже разобранный отказ разбирается как есть, а не заново', () => {
    // Заново он потерял бы код: у `PortalError` нет ни ответа, ни обёртки SDK за спиной.
    expect(refusalCode(asPortalError(new PortalError('SHEF_REJECTED', 'описание')))).toBe('SHEF_REJECTED')
  })

  it('системная ошибка Node с кодом — не код портала', () => {
    // `ECONNREFUSED` и коды базы — про нашу сторону, и принять по ним решение «не повторять» нельзя.
    const system = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })

    expect(refusalCode(asPortalError(system))).toBe('')
  })

  it('коды SDK и axios наружу как коды отказа не выдаются', async () => {
    // `JSSDK_*` и `ERR_*` — это про SDK и транспорт, а не про портал: ни объяснить человеку,
    // ни принять решение по ним нельзя. Тело здесь не портала — значит, и ответа портала нет.
    reply = { status: 500, raw: 'не json', type: 'text/plain' }

    const error = await refusalOf(callTo())

    expect(refusalCode(error)).toBe('SHEF_UNREACHABLE')
    expect(isRetryableRefusal(error)).toBe(true)
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
 * Ответа портала нет — или портал отказал, не назвав кода (issue #99).
 *
 * ⚠ Обе ошибки прежде путались в обратную сторону. Сетевой код SDK (`ECONNRESET`) доезжал до
 * `PortalError.code`, и разрыв связи на разовом шаге обустройства отмечал ревизию навсегда. А отказ
 * проверки с пустым кодом SDK сводит к `ERR_BAD_REQUEST`, и он считался повторимым: портал проходил
 * обустройство целиком каждый час вечно. Нашёл `/review` в панели PR #98.
 *
 * Решает источник ошибки и ТЕЛО ответа, а не статус: панель PR #106 нашла, что статус не прямой
 * признак — страница прокси с 403 выходила «отказом портала», а обрыв посреди сжатого тела приходит
 * с настоящим статусом. Формы сняты зондами против SDK 2.2.0 и этого же сервера (29.09).
 */
describe('ответа портала нет — SHEF_UNREACHABLE, повторяем', () => {
  it('ГЛАВНОЕ: связь оборвалась до ответа', async () => {
    delivery = 'drop'

    const error = await refusalOf(callTo())

    expect(refusalCode(error)).toBe('SHEF_UNREACHABLE')
    expect(isRetryableRefusal(error)).toBe(true)
    expect(isDeadGrant(error)).toBe(false)
    // Код свой, и `safeRefusal` его называет: в журнале беда связи не выглядит «портал отказал».
    expect(safeRefusal(error)).toBe('SHEF_UNREACHABLE')
  })

  it.each([200, 400])('ГЛАВНОЕ: связь оборвалась посреди сжатого тела (статус %s уже пришёл)', async (status) => {
    // ⚠ Заголовки пришли — у ошибки настоящий статус, а код сети (`ECONNRESET`). Правило «статус 0 —
    // беда связи» его пропускало, и обрыв на самом крупном ответе обустройства (`crm.item.list`
    // переноса стадий) снова становился кодом портала. `/code-review` в панели PR #106.
    reply = { status }
    delivery = 'truncate'

    const error = await refusalOf(callTo())

    expect(refusalCode(error)).toBe('SHEF_UNREACHABLE')
    expect(isRetryableRefusal(error)).toBe(true)
  })

  it.each<[string, number, string, string]>([
    ['страница прокси при выкладке', 502, 'text/html', '<html><h1>502 Bad Gateway</h1></html>'],
    ['страница «сервис недоступен»', 503, 'text/html', '<html>Service Unavailable</html>'],
    ['страница WAF с отказом', 403, 'text/html', '<html>Request blocked</html>'],
    ['JSON без ключа error', 404, 'application/json', '{"message":"no route"}'],
    ['408 без тела', 408, 'text/plain', ''],
    ['429 без тела', 429, 'text/plain', ''],
  ])('ответил не портал: %s (%s)', async (_name, status, type, raw) => {
    // «Отказ — это ответ с ключом `error` в теле» («Коды ошибок»). Страница с тем же 403 — не отказ
    // портала, и отпустить шаг навсегда из-за неё значило бы ошибиться в сторону «окончательно»
    // (безопасность, программист и `/review` в панели PR #106).
    reply = { status, raw, type }

    const error = await refusalOf(callTo())

    expect(refusalCode(error)).toBe('SHEF_UNREACHABLE')
    expect(isRetryableRefusal(error)).toBe(true)
  })

  it('наш собственный таймаут: кода нет, повторяем, в журнале — «не ответил вовремя»', async () => {
    // Портал молчит; без `withTimeout` вызов висел бы до таймаута axios. Время подставное.
    delivery = 'hang'
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = refusalOf(callTo())
    await vi.advanceTimersByTimeAsync(20_000)

    const error = await pending

    expect(refusalCode(error)).toBe('')
    expect(isRetryableRefusal(error)).toBe(true)
    expect(safeRefusal(error)).toBe('портал не ответил вовремя')
  })
})

describe('портал отказал без кода — SHEF_REJECTED, не повторяем', () => {
  it.each<[string, number, unknown]>([
    ['пустой код — отказ проверки', 400, { error: '', error_description: 'Section at index 0 does not have title.' }],
    ['код «0»', 400, { error: '0', error_description: 'Нельзя изменить закрытое дело' }],
    ['«Not found» из документации', 400, { error: '', error_description: 'Not found' }],
    ['пустой код при 403', 403, { error: '', error_description: 'Access denied' }],
  ])('ГЛАВНОЕ: %s (%s)', async (_name, status, body) => {
    reply = { status, body }

    const error = await refusalOf(callTo())

    expect(refusalCode(error)).toBe('SHEF_REJECTED')
    expect(isRetryableRefusal(error)).toBe(false)
    // Код свой, и `safeRefusal` его называет — в журнал уходит он, а не проза портала.
    expect(safeRefusal(error)).toBe('SHEF_REJECTED')
  })

  it.each([500, 408, 429])('портал ответил %s без кода — повторяем: это лечит время', async (status) => {
    // Ответ портала — тело с ключом `error`, — но 5xx это сбой на его стороне, а 408 и 429 — «не дождался»
    // и «притормозите». Та же граница у самого SDK.
    reply = { status, body: { error: '', error_description: 'описание портала' } }

    const error = await refusalOf(callTo())

    expect(refusalCode(error)).toBe('')
    expect(isRetryableRefusal(error)).toBe(true)
  })

  it.each<[number, string, boolean]>([
    [429, 'OPERATION_TIME_LIMIT', true],
    [503, 'QUERY_LIMIT_EXCEEDED', true],
    [400, 'ACCESS_DENIED', false],
  ])('портал назвал код (%s %s) — код сохраняется и решает сам', async (status, code, retryable) => {
    reply = { status, body: { error: code, error_description: 'описание портала' } }

    const error = await refusalOf(callTo())

    expect(refusalCode(error)).toBe(code)
    expect(isRetryableRefusal(error)).toBe(retryable)
  })

  it('мягкий результат: код, который SDK не бросает, а возвращает, доезжает как есть', async () => {
    reply = { status: 400, body: { error: 'ERROR_ENTITY_NOT_FOUND', error_description: 'Not found' } }

    const error = await refusalOf(callTo())

    expect(refusalCode(error)).toBe('ERROR_ENTITY_NOT_FOUND')
    expect(isRetryableRefusal(error)).toBe(false)
  })

  it('двухсотый ответ с кодом «0» — отказ без кода, а не код SDK', async () => {
    // SDK зовёт его `JSSDK_RESPONSE_ERROR` и отдаёт мягким результатом — и прежде этот код SDK утекал
    // наружу как код портала (программист и тестировщик в панели PR #106).
    reply = { status: 200, body: { error: '0', error_description: 'Some error' } }

    const error = await refusalOf(callTo())

    expect(refusalCode(error)).toBe('SHEF_REJECTED')
  })
})

/**
 * Продление токена — насквозь: настоящий SDK и заглушка сервера авторизации.
 *
 * `makePortalCall` шлёт продление на зашитый адрес, но сам `B24OAuth` принимает `serverEndpoint`,
 * и клиент с истёкшим токеном идёт за продлением к нашему серверу (тестировщик и `/review`
 * в панели PR #106). Так проверяется настоящая форма ошибки продления, а не наше представление о ней.
 */
describe('продление токена', () => {
  function expiredClient() {
    return new B24OAuth(
      {
        applicationToken: '',
        userId: 0,
        memberId: 'm1',
        accessToken: 'доступ',
        refreshToken: 'обновление',
        expires: Math.floor(Date.now() / 1000) - 10,
        expiresIn: 3600,
        scope: 'crm',
        domain: `127.0.0.1:${port}`,
        clientEndpoint: `https://127.0.0.1:${port}/rest/`,
        serverEndpoint: `https://127.0.0.1:${port}/rest/`,
        status: 'L',
      } as never,
      { clientId: 'клиент', clientSecret: 'секрет' },
      { restrictionParams: { maxRetries: 1, retryOnNetworkError: false } } as never,
    )
  }

  /** Бросок SDK при вызове, который ушёл за продлением, — через наш разборщик. */
  function refreshRefusal(): Promise<PortalError> {
    return rejectionOf(async () => {
      try {
        await expiredClient().actions.v2.call.make({ method: 'crm.item.update', params: {} })
      }
      catch (error) {
        throw asPortalError(error)
      }
    })
  }

  it('ГЛАВНОЕ: сервер авторизации ответил invalid_grant — грант мёртв', async () => {
    authReply = { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid grant' } }

    const error = await refreshRefusal()

    expect(isDeadGrant(error)).toBe(true)
  })

  it('ГЛАВНОЕ: сеть оборвалась посреди продления — ответа нет, а не мёртвый грант', async () => {
    dropAuth = true

    const error = await refreshRefusal()

    expect(refusalCode(error)).toBe('SHEF_UNREACHABLE')
    expect(isRetryableRefusal(error)).toBe(true)
    expect(isDeadGrant(error)).toBe(false)
  })

  it('страница шлюза вместо ответа сервера авторизации — ответа нет, а не отказ', async () => {
    authReply = { status: 403, raw: '<html>Forbidden</html>', type: 'text/html' }

    const error = await refreshRefusal()

    expect(refusalCode(error)).toBe('SHEF_UNREACHABLE')
    expect(isRetryableRefusal(error)).toBe(true)
  })

  it('наше собственное исключение при записи продлённых токенов — не код портала', async () => {
    // Запись пары в базу — наш код (`onRefresh`). Её системный код (`ECONNREFUSED`) — не отказ
    // портала, и принять по нему решение «не повторять» значило бы повторить дефект #99 на соседнем
    // пути (безопасность и программист в панели PR #106).
    authReply = {
      status: 200,
      body: { access_token: 'новый', refresh_token: 'новый', expires: 9999999999, expires_in: 3600, client_endpoint: `https://127.0.0.1:${port}/rest/`, server_endpoint: `https://127.0.0.1:${port}/rest/`, scope: 'crm', status: 'L' },
    }
    const client = expiredClient()
    client.setCallbackRefreshAuth(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    })

    const error = await rejectionOf(async () => {
      try {
        await client.actions.v2.call.make({ method: 'crm.item.update', params: {} })
      }
      catch (caught) {
        throw asPortalError(caught)
      }
    })

    expect(refusalCode(error)).toBe('')
    expect(isRetryableRefusal(error)).toBe(true)
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

  it('отказ команды пакета пишется в журнал кодом портала из-под обёртки SDK', async () => {
    // SDK заворачивает отказ команды в `JSSDK_BATCH_SUB_ERROR`, а настоящий код — внутри. Не развернув,
    // журнал сказал бы «что-то не отработало» без ответа на вопрос ЧТО.
    reply = envelope(
      { deal: { item: { id: 2, title: 'Test' } } },
      { company: { error: 'NOT_FOUND', error_description: 'Элемент не найден' } },
    )
    const warn = vi.spyOn(logger, 'warn')

    await portalTo().batch({
      deal: { method: 'crm.item.get', params: { entityTypeId: 2, id: 2 } },
      company: { method: 'crm.item.get', params: { entityTypeId: 4, id: 0 } },
    })

    expect(warn).toHaveBeenCalledWith({ command: 'company', code: 'NOT_FOUND' }, 'команда пакета не отработала')
    warn.mockRestore()
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
