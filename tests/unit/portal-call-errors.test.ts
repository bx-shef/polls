import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import process from 'node:process'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AjaxError, RefreshTokenError } from '@bitrix24/b24jssdk'
import { asPortalError, makePortalCall } from '../../server/b24/client'
import { CODELESS_REFUSAL, safeRefusal, UNKNOWN_REFUSAL } from '../../server/domain/answers/portal-errors'
import { isDeadGrant } from '../../server/domain/portals/lifecycle'
import { isScopeRefusal } from '../../server/domain/portals/scopes'
import { readNextOffset } from '../../server/domain/portals/smart-processes'
import { listAllTypes } from '../../server/b24/provision'
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
 * настоящий HTTP-сервер и настоящий клиент SDK: ответ портала не подделывается. Руками собраны
 * лишь три формы, и каждая так и названа: мёртвый грант с другим статусом вложенной ошибки
 * (настоящие классы SDK), ошибка axios с телом портала (класс SDK вокруг утиной ошибки axios)
 * и системная ошибка Node.
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
/** Ответ «портала», выбранный по телу запроса, — для листания: страница зависит от `start`. Перекрывает `reply`. */
let respond: ((request: Record<string, unknown>) => typeof reply) | null = null
/**
 * Как «портал» обходится с соединением: отвечает; рвёт его до ответа; молчит; рвёт посреди сжатого
 * тела — так выглядит обрыв, когда заголовки уже пришли и статус у ошибки настоящий (`/code-review`
 * в панели PR #106).
 */
let delivery: 'answer' | 'drop' | 'hang' | 'truncate' = 'answer'
/** Что отвечает «сервер авторизации» на продление. */
let authReply: { status: number, body?: unknown, raw?: string, type?: string } = { status: 200, body: { result: true } }
/** Как «сервер авторизации» обходится с соединением: отвечает, рвёт его до ответа или посреди сжатого тела. */
let authDelivery: 'answer' | 'drop' | 'truncate' = 'answer'
/**
 * Сколько запросов дошло до сервера.
 *
 * ⚠ Без счёта тест беды связи мерил бы что угодно: мёртвый прокси из окружения тоже даёт «ответа нет»,
 * и проверка проходила бы, ни разу не дойдя до нашего сервера (программист в панели PR #106).
 */
let hits = 0
/** Сколько из них — продление токена. */
let authHits = 0
/** Тело последнего запроса к «порталу» — чтобы проверить, что именно ушло. */
let lastBody = ''

let server: Server
let port = 0
let certDir = ''
let previousTlsSetting: string | undefined
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
  // Обе переменные: axios (`proxy-from-env`) читает строчную раньше заглавной (программист, тестировщик
  // во втором круге панели PR #106).
  vi.stubEnv('NO_PROXY', '127.0.0.1')
  vi.stubEnv('no_proxy', '127.0.0.1')

  server = createServer({
    key: readFileSync(join(certDir, 'key.pem')),
    cert: readFileSync(join(certDir, 'cert.pem')),
  }, (req, res) => {
    hits += 1
    let raw = ''
    req.on('data', chunk => (raw += chunk))
    req.on('end', () => {
      const isAuth = (req.url ?? '').includes('token') || (req.url ?? '').includes('oauth')
      if (!isAuth) lastBody = raw
      else authHits += 1
      const how = isAuth ? authDelivery : delivery
      if (how === 'drop') {
        req.socket.destroy()
        return
      }
      if (how === 'hang') {
        inFlight.add(req.socket)
        return
      }
      if (how === 'truncate') {
        res.writeHead((isAuth ? authReply : reply).status, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(GZIPPED.length) })
        res.write(GZIPPED.subarray(0, Math.floor(GZIPPED.length / 2)))
        inFlight.add(req.socket)
        setTimeout(() => req.socket.destroy(), 30)
        return
      }
      const { status, body, raw: rawBody, type } = isAuth ? authReply : (respond === null ? reply : respond(JSON.parse(raw || '{}') as Record<string, unknown>))
      res.writeHead(status, { 'content-type': type ?? 'application/json' })
      res.end(rawBody ?? JSON.stringify(body))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})

afterEach(() => {
  delivery = 'answer'
  authDelivery = 'answer'
  respond = null
  for (const socket of inFlight) socket.destroy()
  inFlight.clear()
  vi.useRealTimers()
})

afterAll(() => {
  vi.unstubAllEnvs()
  server.close()
  rmSync(certDir, { recursive: true, force: true })
  if (previousTlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsSetting
})

/**
 * Клиент, смотрящий на наш сервер.
 *
 * Токен у него живой, и продление здесь не запускается — его проверяет клиент с истёкшим токеном
 * в «продлении токена» ниже. ⚠ Адрес сервера авторизации всё равно наш, локальный: ответ портала
 * `401 expired_token` в будущем тесте отправил бы SDK за продлением, и с адресом по умолчанию —
 * на настоящий `oauth.bitrix.info` (тестировщик в закрывающем круге панели PR #106).
 */
function portalTo() {
  return makePortalCall(
    {
      memberId: 'm1',
      domain: `127.0.0.1:${port}`,
      accessToken: 'доступ',
      refreshToken: 'обновление',
      applicationToken: '',
      expiresIn: 3600,
      scope: ['crm'],
    },
    undefined,
    `https://127.0.0.1:${port}/rest/`,
  )
}

/**
 * Дождаться, пока запрос дойдёт до «портала», — не дольше двух секунд настоящего времени.
 *
 * ⚠ Граница нужна: без неё недошедший запрос (мёртвый прокси) давал бы вечный цикл и два чужих таймаута
 * вместо ясного «запрос не дошёл» (тестировщик в закрывающем круге панели PR #106). Время настоящее:
 * подставные таймеры подменяют только `setTimeout`, а `Date` и `setImmediate` — нет.
 */
async function reached(before: number): Promise<void> {
  const deadline = Date.now() + 2000
  while (hits === before && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
  expect(hits, 'запрос не дошёл до «портала»').toBeGreaterThan(before)
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
async function refusalOf(run: () => Promise<unknown>): Promise<PortalError> {
  const before = hits
  let caught: unknown
  try {
    await run()
  }
  catch (error) {
    caught = error
  }
  if (caught === undefined) throw new Error('вызов не отказал, хотя должен был')
  expect(caught).toBeInstanceOf(PortalError)
  expect(hits, 'запрос не дошёл до нашего сервера').toBeGreaterThan(before)
  return caught as PortalError
}

/** Отказ одиночного вызова метода — им пользуется большинство проверок ниже. */
function callRefusal(): Promise<PortalError> {
  return refusalOf(() => portalTo().call('crm.item.update', {}))
}

describe('отказ портала доезжает до нас с машинным кодом', () => {
  it('обычный отказ метода: код сохраняется', async () => {
    // ⚠ Именно так SDK и доставляет отказ REST-метода — ИСКЛЮЧЕНИЕМ, а не результатом.
    // Первая редакция `makePortalCall` разбирала только результат, и эта ветка молчала.
    reply = { status: 400, body: { error: 'ACCESS_DENIED', error_description: 'Доступ запрещен' } }

    const error = await callRefusal()

    expect(refusalCode(error)).toBe('ACCESS_DENIED')
    expect(safeRefusal(error)).toBe('ACCESS_DENIED')
    expect(isDeadGrant(error)).toBe(false)
  })

  it.each([0, undefined])('мёртвый грант — при любом статусе вложенной ошибки (%s): сдвиг статуса в SDK его не спрячет', (status) => {
    // ⚠ Самый важный класс файла: признание мёртвого гранта — единственный способ узнать
    // об уходе клиента. Настоящий путь — насквозь через сокет — держит «продление токена» ниже;
    // здесь — что статус вложенной ошибки решения не меняет. SDK держим как `^2.2.0`, и сдвиг
    // статуса в минорной версии иначе молча превратил бы `invalid_grant` в беду связи
    // (безопасность в панели PR #106). Классы — настоящие. Ответ 2xx с `invalid_grant` сюда
    // не доезжает вовсе: SDK прячет его сам (issue #111).
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

  it('ошибка axios с `response: null` — ответа нет, а не исключение из разборщика', () => {
    // Настоящий axios такого не ставит, но разборщик — граница, и чужая структура читается защитно (`/review`).
    const axiosLike = Object.assign(new Error('x'), { isAxiosError: true, code: 'ECONNRESET', response: null })
    const wrapped = new AjaxError({ code: 'ECONNRESET', description: 'x', status: 0, originalError: axiosLike, requestInfo: { method: 'crm.item.update' } } as never)

    expect(refusalCode(asPortalError(wrapped))).toBe('SHEF_UNREACHABLE')
  })

  it('системная ошибка Node с кодом — не код портала', () => {
    // `ECONNREFUSED` и коды базы — про нашу сторону, и принять по ним решение «не повторять» нельзя.
    const system = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })

    expect(refusalCode(asPortalError(system))).toBe('')
  })

  it('тело не портала (500, не JSON) — ответа нет, а не код axios', async () => {
    // Код axios (`ERR_BAD_RESPONSE`) — про транспорт, а не про портал: ни объяснить человеку, ни принять
    // решение по нему нельзя. Тело здесь не портала — значит, и ответа портала нет. Правило «код SDK —
    // не код портала» держат отказы без кода ниже (`ERR_*`) и исключение в `onRefresh` (`JSSDK_*`).
    reply = { status: 500, raw: 'не json', type: 'text/plain' }

    const error = await callRefusal()

    expect(refusalCode(error)).toBe('SHEF_UNREACHABLE')
    expect(isRetryableRefusal(error)).toBe(true)
    expect(isDeadGrant(error)).toBe(false)
  })

  it('успешный вызов возвращает данные, а не бросает', async () => {
    // Гвард под обёртку: перехватывая исключения, легко проглотить и удачу.
    reply = { status: 200, body: { result: { item: { id: 7 } }, time: { start: 1, finish: 2, duration: 1 } } }
    authReply = { status: 200, body: { result: true } }

    await expect(portalTo().call('crm.item.get', {})).resolves.toMatchObject({ result: { item: { id: 7 } } })
  })

  it.each<[string, unknown]>([
    ['false — ответ `user.admin` не администратору', false],
    ['0', 0],
    ['пустая строка', ''],
    ['null', null],
    ['пустой список', []],
  ])('ГЛАВНОЕ: результат %s — это успех, а не «в ответе нет результата»', async (_name, result) => {
    // ⚠ Успех — ответ С полем `result`, каким бы ни было его значение. `!data.result` выдал бы `false` от
    // `user.admin` за беду связи, и мастер установки повторял бы вместо «нужны права администратора».
    reply = { status: 200, body: { result, time: { start: 1, finish: 2, duration: 1 } } }

    await expect(portalTo().call('user.admin', {})).resolves.toMatchObject({ result })
  })

  it('ГЛАВНОЕ: отказ по правам доезжает до мастера установки — код в поле, в тексте его нет', async () => {
    // ⚠ Насквозь: настоящий SDK, настоящий сокет, а затем сам `isScopeRefusal`. Тесты мастера строят такую
    // ошибку руками — и держат нашу догадку о форме, а не форму.
    reply = { status: 401, body: { error: 'insufficient_scope', error_description: 'The request requires higher privileges than provided by the access token' } }

    const error = await callRefusal()

    expect(refusalCode(error)).toBe('insufficient_scope')
    expect(isScopeRefusal(error)).toBe(true)
    expect(isRetryableRefusal(error)).toBe(false)
    expect(error.message).not.toContain('insufficient_scope')
  })

  it.each<[string, unknown]>([
    ['REST v3: объект с кодом', { error: { code: 'BITRIX_REST_V3_EXCEPTION_ACCESSDENIEDEXCEPTION', message: 'Access denied' } }],
    ['код нижним регистром', { error: 'invalid_request', error_description: 'x' }],
    ['код с цифрой', { error: 'WRONG_ARG_2', error_description: 'x' }],
  ])('портал назвал код в другой форме: %s — код сохраняется', async (_name, body) => {
    reply = { status: 400, body }
    const expected = typeof (body as { error: unknown }).error === 'string' ? (body as { error: string }).error : (body as { error: { code: string } }).error.code

    const error = await callRefusal()

    expect(refusalCode(error)).toBe(expected)
    expect(isRetryableRefusal(error)).toBe(false)
  })
})

/**
 * Листание — через настоящий SDK: `next` списочного метода доезжает до вызывающего (issue #110).
 *
 * ⚠ SDK отдаёт в `getData()` только `{ result, time }`, и до #110 `readNextOffset` на боевом пути видел
 * `null` всегда. Подделки портала в прочих тестах кладут `next` сами, а живые проверки ходят вебхуком,
 * который отдаёт тело целиком, — поэтому форму SDK держит только этот блок.
 */
describe('листание списков', () => {
  const time = { start: 1, finish: 2, duration: 1 }

  it('ГЛАВНОЕ: смещение следующей страницы доезжает до вызывающего', async () => {
    reply = { status: 200, body: { result: { types: [] }, next: 50, total: 61, time } }

    expect(readNextOffset(await portalTo().call('crm.type.list', {}))).toBe(50)
  })

  it('последняя страница — без смещения: листание кончается', async () => {
    reply = { status: 200, body: { result: { types: [] }, total: 11, time } }

    expect(readNextOffset(await portalTo().call('crm.type.list', { start: 50 }))).toBeNull()
  })

  it('ГЛАВНОЕ: поиск перед созданием видит смарт-процесс со второй страницы', async () => {
    // Иначе на портале, где смарт-процессов больше пятидесяти, наш не находился бы, и обустройство
    // завело бы второй — при лимите 150 на весь портал (issue #110).
    const type = (id: number) => ({ id, entityTypeId: 1000 + id, title: `Тип ${id}` })
    respond = request => Number(request.start ?? 0) === 50
      ? { status: 200, body: { result: { types: Array.from({ length: 11 }, (_, i) => type(51 + i)) }, total: 61, time } }
      : { status: 200, body: { result: { types: Array.from({ length: 50 }, (_, i) => type(1 + i)) }, next: 50, total: 61, time } }

    const types = await listAllTypes(portalTo().call)

    expect(types).toHaveLength(61)
    expect(types.at(-1)).toMatchObject({ title: 'Тип 61' })
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
describe('ответа портала нет — повторяем', () => {
  it('ГЛАВНОЕ: связь оборвалась до ответа', async () => {
    delivery = 'drop'

    const error = await callRefusal()

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

    const error = await callRefusal()

    expect(refusalCode(error)).toBe('SHEF_UNREACHABLE')
    expect(isRetryableRefusal(error)).toBe(true)
  })

  it.each<[string, number, string, string]>([
    ['страница прокси при выкладке', 502, 'text/html', '<html><h1>502 Bad Gateway</h1></html>'],
    ['страница «сервис недоступен»', 503, 'text/html', '<html>Service Unavailable</html>'],
    ['страница WAF с отказом', 403, 'text/html', '<html>Request blocked</html>'],
    ['JSON без ключа error', 404, 'application/json', '{"message":"no route"}'],
    ['JSON шлюза: error — не строка', 403, 'application/json', '{"error":true}'],
    ['JSON шлюза: error — объект без code', 403, 'application/json', '{"error":{"message":"blocked"}}'],
    ['JSON шлюза: error — null', 403, 'application/json', '{"error":null}'],
    ['JSON шлюза: код без описания', 403, 'application/json', '{"error":"Forbidden"}'],
    ['JSON шлюза при 503: код без описания', 503, 'application/json', '{"error":"unavailable"}'],
    ['проза шлюза вместо кода', 502, 'application/json', '{"error":"Bad gateway"}'],
    ['проза вместо кода, хоть и с описанием', 403, 'application/json', '{"error":"Access denied by policy","error_description":"x"}'],
    ['JSON null вместо тела', 400, 'application/json', 'null'],
    ['страница прокси со словом error', 502, 'text/html', '<html><h1>502 Bad Gateway</h1><p>upstream error</p></html>'],
    ['408 без тела', 408, 'text/plain', ''],
    ['429 без тела', 429, 'text/plain', ''],
  ])('ответил не портал: %s (%s)', async (_name, status, type, raw) => {
    // «Отказ — это ответ с ключом `error` в теле» («Коды ошибок»): строкой, пустой в том числе, или
    // объектом REST v3 с `code` — ровно то, что признаёт и сам SDK. Страница с тем же 403 или чужой JSON —
    // не отказ портала, и отпустить шаг навсегда из-за них значило бы ошибиться в сторону «окончательно»
    // (безопасность, программист и `/review` в панели PR #106).
    reply = { status, raw, type }

    const error = await callRefusal()

    expect(refusalCode(error)).toBe('SHEF_UNREACHABLE')
    expect(isRetryableRefusal(error)).toBe(true)
  })

  it.each<[string, unknown]>([
    ['одно поле `time`', { time: { start: 1, finish: 2, duration: 1 } }],
    ['пустой `error` рядом с `time`', { error: '', time: { start: 1, finish: 2, duration: 1 } }],
  ])('ГЛАВНОЕ: двухсотый ответ без `result` (%s) — не успех', async (_name, body) => {
    // ⚠ SDK считает такой ответ успехом и отдаёт `{ result: undefined }`; вызывающий прочитал бы его
    // как «ничего нет», а пустой список типов перед созданием — это второй смарт-процесс. Успех — ответ
    // С `result` («Коды ошибок»). Нашёл программист в панели PR #106.
    reply = { status: 200, body }

    const error = await callRefusal()

    expect(refusalCode(error)).toBe('SHEF_UNREACHABLE')
    expect(isRetryableRefusal(error)).toBe(true)
  })

  it('наш собственный таймаут: кода нет, повторяем, в журнале — «не ответил вовремя»', async () => {
    // Портал молчит; без `withTimeout` вызов висел бы до таймаута axios. Время подставное.
    delivery = 'hang'
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const before = hits
    const pending = callRefusal()
    // ⚠ Сначала запрос должен ДОЙТИ до «портала», и только потом идёт время. Иначе подставные двадцать
    // секунд истекали раньше, чем завершалось рукопожатие TLS, и тест мерил таймаут без молчащего
    // портала — вскрыл счётчик обращений, заведённый во втором круге панели PR #106.
    await reached(before)
    let settled = false
    void pending.finally(() => (settled = true))
    // Ровно двадцать секунд: не раньше — медленный портал не отрезается, и не позже (тестировщик там же).
    await vi.advanceTimersByTimeAsync(19_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    const error = await pending

    expect(refusalCode(error)).toBe('')
    expect(isRetryableRefusal(error)).toBe(true)
    expect(safeRefusal(error)).toBe('портал не ответил вовремя')
  })

  it('пакет тоже не ждёт вечно', async () => {
    delivery = 'hang'
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const before = hits
    const pending = refusalOf(() => portalTo().batch({ deal: { method: 'crm.item.get', params: { id: 1 } } }))
    await reached(before)
    await vi.advanceTimersByTimeAsync(20_000)

    const error = await pending

    expect(safeRefusal(error)).toBe('портал не ответил вовремя')
  })

  it.each<[string, { status: number, body: unknown }]>([
    ['успешного', { status: 200, body: { result: { item: { id: 7 } }, time: { start: 1, finish: 2, duration: 1 } } }],
    ['отказа', { status: 400, body: { error: 'ACCESS_DENIED', error_description: 'x' } }],
  ])('таймер снимается после %s ответа — не держит процесс живым', async (_name, answer) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    reply = answer

    await portalTo().call('crm.item.get', {}).catch(() => {})

    expect(vi.getTimerCount()).toBe(0)
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

    const error = await callRefusal()

    expect(refusalCode(error)).toBe('SHEF_REJECTED')
    expect(isRetryableRefusal(error)).toBe(false)
    // Код свой, и `safeRefusal` его называет — в журнал уходит он, а не проза портала.
    expect(safeRefusal(error)).toBe('SHEF_REJECTED')
  })

  it.each([400, 401, 403, 404, 409, 422, 499])('граница окончательного: отказ без кода при %s — SHEF_REJECTED', async (status) => {
    // Весь диапазон 4xx, кроме 408 и 429, а не две точки из него (тестировщик в панели PR #106).
    reply = { status, body: { error: '', error_description: 'описание портала' } }

    const error = await callRefusal()

    expect(refusalCode(error)).toBe('SHEF_REJECTED')
  })

  it.each<[string, number]>([
    ['SHEF_REJECTED', 503],
    ['SHEF_CREATED_NOTHING', 400],
    ['JSSDK_UNKNOWN_ERROR', 403],
    ['ERR_BAD_REQUEST', 400],
  ])('чужой код в теле ответа (%s при %s) — не код портала: ответа портала нет', async (code, status) => {
    // Код SDK, axios или наш портал назвать не может. Принятый как есть, он выбирал бы решение за нас:
    // `SHEF_REJECTED` при 503 отпустил бы шаг навсегда (безопасность в панели PR #106).
    reply = { status, body: { error: code, error_description: 'описание' } }

    const error = await callRefusal()

    expect(refusalCode(error)).toBe('SHEF_UNREACHABLE')
    expect(isRetryableRefusal(error)).toBe(true)
  })

  it.each<[number, string]>([
    [502, 'gateway_timeout'],
    [500, 'SOME_NEW_SERVER_CODE'],
    [429, 'ratelimited'],
    [408, 'TIMEOUT'],
  ])('незнакомый код при %s (%s) — сбой или предел, а не отказ метода: повторяем', async (status, code) => {
    // Документация различает системные ошибки и ошибки метода статусом: ошибки метода — с 400 и 403,
    // а системные коды с 5xx и 429 она велит повторять. Незнакомый код шлюза при выкладке иначе отпустил
    // бы разовый шаг обустройства навсегда (безопасность и `/review` в закрывающем круге панели PR #106).
    reply = { status, body: { error: code, error_description: 'описание' } }

    const error = await callRefusal()

    expect(refusalCode(error)).toBe('')
    expect(isRetryableRefusal(error)).toBe(true)
  })

  it('незнакомый код при временном статусе: код стёрт, но статус — в журнале, а сам код — нет', async () => {
    // Иначе при выкладке не было бы видно, что повтор идёт из-за ответа портала (`/review` в закрывающем круге).
    // Незнакомого кода в журнале нет: он не из нашего списка.
    reply = { status: 502, body: { error: 'gateway_timeout', error_description: 'описание' } }
    const warn = vi.spyOn(logger, 'warn')

    try {
      await callRefusal()

      expect(warn).toHaveBeenCalledWith({ status: 502 }, 'портал ответил незнакомым кодом при временном статусе — повторим')
      expect(JSON.stringify(warn.mock.calls)).not.toContain('gateway_timeout')
    }
    finally {
      warn.mockRestore()
    }
  })

  it('ГЛАВНОЕ: invalid_grant в ответе на вызов — не мёртвый грант: его признаёт только продление', async () => {
    // Иначе любой, кто держит тело ответа, — шлюз, прокси, — запускал бы отсчёт до стирания токенов
    // (безопасность в закрывающем круге панели PR #106).
    reply = { status: 400, body: { error: 'invalid_grant', error_description: 'x' } }

    const error = await callRefusal()

    expect(refusalCode(error)).toBe('SHEF_UNREACHABLE')
    expect(isDeadGrant(error)).toBe(false)
  })

  it.each([500, 408, 429])('портал ответил %s без кода — повторяем: это лечит время', async (status) => {
    // Ответ портала — тело с ключом `error`, — но 5xx это сбой на его стороне, а 408 и 429 — «не дождался»
    // и «притормозите». Та же граница у самого SDK.
    reply = { status, body: { error: '', error_description: 'описание портала' } }

    const error = await callRefusal()

    expect(refusalCode(error)).toBe('')
    expect(isRetryableRefusal(error)).toBe(true)
    // Пустой код — исход любого постороннего исключения; текст показывает, что дошёл именно ответ портала.
    expect(error.message).toContain(`status code ${status}`)
  })

  it.each<[number, string, boolean]>([
    [429, 'OPERATION_TIME_LIMIT', true],
    [503, 'QUERY_LIMIT_EXCEEDED', true],
    [400, 'ACCESS_DENIED', false],
  ])('портал назвал код (%s %s) — код сохраняется и решает сам', async (status, code, retryable) => {
    reply = { status, body: { error: code, error_description: 'описание портала' } }

    const error = await callRefusal()

    expect(refusalCode(error)).toBe(code)
    expect(isRetryableRefusal(error)).toBe(retryable)
  })

  it('мягкий результат: код, который SDK не бросает, а возвращает, доезжает как есть', async () => {
    reply = { status: 400, body: { error: 'ERROR_ENTITY_NOT_FOUND', error_description: 'Not found' } }

    const error = await callRefusal()

    expect(refusalCode(error)).toBe('ERROR_ENTITY_NOT_FOUND')
    expect(isRetryableRefusal(error)).toBe(false)
  })

  it('двухсотый ответ с кодом «0» — отказ без кода, а не код SDK', async () => {
    // SDK зовёт его `JSSDK_RESPONSE_ERROR` и отдаёт мягким результатом — и прежде этот код SDK утекал
    // наружу как код портала (программист и тестировщик в панели PR #106).
    reply = { status: 200, body: { error: '0', error_description: 'Some error' } }

    const error = await callRefusal()

    expect(refusalCode(error)).toBe('SHEF_REJECTED')
  })
})

/**
 * Продление токена — насквозь: наш `makePortalCall` с истёкшим токеном и заглушка сервера авторизации.
 *
 * Адрес сервера авторизации у клиента подменён на наш (`serverEndpoint`), и продление идёт сюда,
 * а не наружу. Так проверяется настоящая форма ошибки продления и наша обвязка вокруг неё — `onRefresh`
 * в том числе, — а не наше представление о них (тестировщик и `/review` в панели PR #106).
 */
describe('продление токена', () => {
  /** Клиент с истёкшим токеном: первый же вызов идёт за продлением. */
  function expiredPortal(onRefresh?: Parameters<typeof makePortalCall>[1]) {
    return makePortalCall(
      {
        memberId: 'm1',
        domain: `127.0.0.1:${port}`,
        accessToken: 'доступ',
        refreshToken: 'обновление',
        applicationToken: '',
        expiresIn: -10,
        scope: ['crm'],
      },
      onRefresh,
      `https://127.0.0.1:${port}/rest/`,
    )
  }

  /** Отказ вызова, который ушёл за продлением. */
  async function refreshRefusal(onRefresh?: Parameters<typeof makePortalCall>[1]): Promise<PortalError> {
    const before = authHits
    const error = await refusalOf(() => expiredPortal(onRefresh).call('crm.item.update', {}))
    // ⚠ Без этой строки тесты ниже проходили вхолостую: клиент, которого не отправили на продление, доходил до
    // «портала» и получал то, что оставил в `reply` соседний тест, — и в половине порядков это тоже «ответа нет».
    expect(authHits, 'продление не дошло до сервера авторизации').toBeGreaterThan(before)
    return error
  }

  it.each([400, 401, 500])('ГЛАВНОЕ: сервер авторизации ответил invalid_grant (%s) — грант мёртв', async (status) => {
    // Статус решения не меняет: сетью `invalid_grant` не получить (безопасность в панели PR #106).
    authReply = { status, body: { error: 'invalid_grant', error_description: 'Invalid grant' } }

    const error = await refreshRefusal()

    expect(isDeadGrant(error)).toBe(true)
  })

  it('ГЛАВНОЕ: сеть оборвалась посреди продления — ответа нет, а не мёртвый грант', async () => {
    authDelivery = 'drop'

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

  it.each([200, 400])('ГЛАВНОЕ: ответ сервера авторизации оборвался посреди тела (статус %s уже пришёл) — ответа нет', async (status) => {
    // ⚠ У ошибки настоящий статус, а код — сети (`ECONNRESET`). Правило «статус есть — код сервера»
    // пропускало его, и обрыв отмечал шаг навсегда: тот же класс, что #99 (`/code-review`, программист
    // и безопасность во втором круге панели PR #106).
    authReply = { status }
    authDelivery = 'truncate'

    const error = await refreshRefusal()

    expect(refusalCode(error)).toBe('SHEF_UNREACHABLE')
    expect(isRetryableRefusal(error)).toBe(true)
  })

  it.each<[string, number, unknown]>([
    ['наша пара ключей (`invalid_client`)', 401, { error: 'invalid_client', error_description: 'Invalid client' }],
    ['сбой сервера авторизации', 503, { error: 'server_error', error_description: 'Try later' }],
    ['отказ без кода', 400, { error: '0', error_description: 'Some error' }],
  ])('продление отвергнуто, но грант жив: %s (%s) — ответа нет, повторяем', async (_name, status, body) => {
    // Токена нет — до портала вызов не дошёл, и вердикта о нём никто не выносил. Тот же принцип у нашего
    // обмена токена (`server/b24/oauth.ts`: неперечисленное — `unavailable`): чинит это исправленная
    // настройка или время, а не отметка шага навсегда (`/review` и программист во втором круге панели PR #106).
    authReply = { status, body }

    const error = await refreshRefusal()

    expect(refusalCode(error)).toBe('SHEF_UNREACHABLE')
    expect(isRetryableRefusal(error)).toBe(true)
    expect(isDeadGrant(error)).toBe(false)
  })

  it.each<[string, string, string]>([
    ['наша пара ключей', 'invalid_client', 'invalid_client'],
    ['управляющая последовательность', '\u001B[2J текст', 'не код'],
    ['64 шестнадцатеричных знака', 'deadbeef'.repeat(8), 'не код'],
  ])('в журнал продления уходит код только из нашего списка: %s', async (_name, code, logged) => {
    // `invalid_client` на всём флоте — это наша настройка, а наружу он уходит `SHEF_UNREACHABLE`. Без строки
    // в журнале оператор искал бы сеть (программист и технический директор в закрывающем круге). Но журнал
    // ВЫБИРАЕТ из своего списка, а не фильтрует чужую строку формой (`/code-review` там же).
    authReply = { status: 401, body: { error: code, error_description: 'x' } }
    const warn = vi.spyOn(logger, 'warn')

    try {
      await refreshRefusal()

      expect(warn).toHaveBeenCalledWith({ code: logged }, 'продление токена не удалось — вызов до портала не дошёл')
    }
    finally {
      warn.mockRestore()
    }
  })

  it('ответ 2xx сервера авторизации с invalid_grant SDK прячет — грант не признаётся (issue #111)', async () => {
    // ⚠ Тест держит ИЗВЕСТНУЮ ДЫРУ, а не желаемое поведение: SDK 2.2.0 бросает на такой ответ свой `SdkError`,
    // и код остаётся только в тексте. Упадёт он, когда SDK начнёт отдавать код, — тогда пересмотреть #111.
    // Держит обещание `PROCESS.md` «каждое место SDK закреплено сквозным тестом» (`/code-review`).
    authReply = { status: 200, body: { error: 'invalid_grant', error_description: 'Invalid grant' } }

    const error = await refreshRefusal()

    expect(refusalCode(error)).toBe('')
    expect(isDeadGrant(error)).toBe(false)
  })

  it('наше собственное исключение при записи продлённых токенов — не код портала', async () => {
    // Запись пары в базу — наш код (`onRefresh`). Её системный код (`ECONNREFUSED`) — не отказ
    // портала, и принять по нему решение «не повторять» значило бы повторить дефект #99 на соседнем
    // пути (безопасность и программист в панели PR #106).
    authReply = {
      status: 200,
      body: { access_token: 'новый', refresh_token: 'новый', expires: 9999999999, expires_in: 3600, client_endpoint: `https://127.0.0.1:${port}/rest/`, server_endpoint: `https://127.0.0.1:${port}/rest/`, scope: 'crm', status: 'L' },
    }

    const onRefresh = vi.fn(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    })

    const error = await refreshRefusal(onRefresh)

    expect(onRefresh).toHaveBeenCalledOnce()

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
    // И ушёл пакет с `halt: 0`: заглушка тела не читает, и без этой строки гвард был зелёным и при
    // `halt: 1` (тестировщик в панели PR #106).
    expect(JSON.parse(lastBody)).toMatchObject({ halt: 0 })
  })

  it.each<[string, unknown, string]>([
    ['код портала', { error: 'NOT_FOUND', error_description: 'Элемент не найден' }, 'NOT_FOUND'],
    ['отказ без кода «0»', { error: '0', error_description: 'Some error' }, 'SHEF_REJECTED'],
    // Строка из тела, которой нет в нашем списке, в журнал не уходит — только фиксированная фраза.
    ['незнакомый код', { error: 'CLIENT_WROTE_THIS', error_description: 'x' }, UNKNOWN_REFUSAL],
    // Мёртвым грант признаёт только продление, а не тело команды (безопасность в закрывающем круге).
    ['мёртвый грант в команде — не наш вердикт', { error: 'invalid_grant', error_description: 'x' }, CODELESS_REFUSAL],
  ])('отказ команды пакета доезжает до журнала безопасной строкой: %s', async (_name, refusal, reason) => {
    // SDK отдаёт отказ команды ошибкой, разобранной из её записи в `result_error`. Без кода журнал сказал бы
    // «что-то не отработало» без ответа на вопрос ЧТО. Пишется через `safeRefusal`: код приходит из тела
    // портала, и мимо него в журнал уехала бы любая строка (безопасность в панели PR #106).
    reply = envelope({ deal: { item: { id: 2, title: 'Test' } } }, { company: refusal })
    const warn = vi.spyOn(logger, 'warn')

    try {
      await portalTo().batch({
        deal: { method: 'crm.item.get', params: { entityTypeId: 2, id: 2 } },
        company: { method: 'crm.item.get', params: { entityTypeId: 4, id: 0 } },
      })

      expect(warn).toHaveBeenCalledWith({ command: 'company', reason }, 'команда пакета не отработала')
    }
    finally {
      warn.mockRestore()
    }
  })

  it('ГЛАВНОЕ: команда с пустым кодом отказа — не «пустые данные»: ключа нет, запись в журнале есть', async () => {
    // ⚠ `"error": ""` в `result_error` — документированная форма отказа, а SDK считает такую команду успехом
    // и отдаёт её ключ с `undefined`. Нарушалось обещание «нет ключа — отказ», и отказ не писался никуда
    // (было issue #108, п. 2; `/review` и технический директор в закрывающем круге панели PR #106).
    reply = envelope({ deal: { item: { id: 2, title: 'Test' } } }, { company: { error: '', error_description: 'Not found' } })
    const warn = vi.spyOn(logger, 'warn')

    try {
      const data = await portalTo().batch({
        deal: { method: 'crm.item.get', params: { entityTypeId: 2, id: 2 } },
        company: { method: 'crm.item.get', params: { entityTypeId: 4, id: 0 } },
      })

      expect(data).not.toHaveProperty('company')
      expect(data.deal).toMatchObject({ item: { title: 'Test' } })
      expect(warn).toHaveBeenCalledWith({ command: 'company', reason: 'портал не вернул результата команды' }, 'команда пакета не отработала')
    }
    finally {
      warn.mockRestore()
    }
  })

  it('отказ всего пакета бросается кодом портала, как и одиночный вызов', async () => {
    // Мёртвый токен, недоступный портал — это не «команда не отработала», а «разговора не было». Молча вернуть
    // пустую карту здесь значило бы выдать отказ портала за «у сделки ничего не заполнено». Нехватку прав
    // документация `batch` описывает иначе — по каждой команде, со статусом 200, — и такой пакет не бросается,
    // а пишет каждую команду в журнал (`/code-review` в закрывающем круге).
    reply = { status: 400, body: { error: 'ACCESS_DENIED', error_description: 'Доступ запрещен' } }
    authReply = { status: 200, body: { result: true } }

    const failed = portalTo().batch({ deal: { method: 'crm.item.get', params: { id: 1 } } })

    await expect(failed).rejects.toSatisfy(error => refusalCode(error) === 'ACCESS_DENIED')
  })

  it.each<[string, number, unknown, string]>([
    ['мягкий код', 400, { error: 'ERROR_ENTITY_NOT_FOUND', error_description: 'Not found' }, 'ERROR_ENTITY_NOT_FOUND'],
    ['двухсотый ответ с «0»', 200, { error: '0', error_description: 'Some error' }, 'SHEF_REJECTED'],
  ])('ГЛАВНОЕ: отказ всего пакета результатом, а не исключением (%s), — тоже бросается', async (_name, status, body, code) => {
    // ⚠ Такой отказ SDK не бросает, а кладёт в набор под ключ `base-error`. Прежде он писался в журнал
    // «командой» `base-error`, а наружу уходил пустой пакет — выпуск ссылки выдавал отказ портала
    // за «у сделки ничего не заполнено». Нашёл `/review` в панели PR #106.
    reply = { status, body }

    const error = await refusalOf(() => portalTo().batch({ deal: { method: 'crm.item.get', params: { id: 1 } } }))

    expect(refusalCode(error)).toBe(code)
  })
})
