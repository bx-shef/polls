import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type Server } from 'node:http'
import { connect as netConnect } from 'node:net'
import { createApp, defineEventHandler, toNodeListener, type App } from 'h3'
import { bodyLimitStatus, MAX_REQUEST_BODY_BYTES } from '../src/api/body-limit'
import { handleBodyLimit } from '../server/middleware/body-limit'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

describe('bodyLimitStatus', () => {
  it('потолок запиннен литералом', () => {
    // Без этой строки все остальные ожидания выражены через саму константу, то есть тест
    // подтверждал бы сам себя: подними потолок до 64 МБ — и он останется зелёным.
    expect(MAX_REQUEST_BODY_BYTES).toBe(131072)
  })

  it('запрос без тела проходит без проверок', () => {
    // Обычный GET: ни длины, ни `Transfer-Encoding`. Это подавляющее большинство запросов, и они
    // обязаны стоить нам ровно ничего.
    expect(bodyLimitStatus({})).toBeNull()
    expect(bodyLimitStatus({ contentLength: undefined, transferEncoding: undefined })).toBeNull()
  })

  it('тело в пределах потолка проходит', () => {
    expect(bodyLimitStatus({ contentLength: '0' })).toBeNull()
    expect(bodyLimitStatus({ contentLength: '1024' })).toBeNull()
    expect(bodyLimitStatus({ contentLength: String(MAX_REQUEST_BODY_BYTES) })).toBeNull()
    expect(bodyLimitStatus({ contentLength: '131072' })).toBeNull()
  })

  it('заявленная длина сверх потолка → 413', () => {
    expect(bodyLimitStatus({ contentLength: '131073' })?.status).toBe(413)
    expect(bodyLimitStatus({ contentLength: '2000000000' })?.status).toBe(413)
  })

  it('chunked без длины → 411, а не «ноль байт»', () => {
    // Ровно тот обход, который был у поимённых капов: `Number(undefined ?? 0)` даёт `0`, и тело
    // без заявленной длины проходило как нулевое — то есть `readBody` буферизовал его целиком.
    expect(bodyLimitStatus({ transferEncoding: 'chunked' })?.status).toBe(411)
    expect(bodyLimitStatus({ transferEncoding: 'gzip, chunked' })?.status).toBe(411)
    expect(bodyLimitStatus({ transferEncoding: 'Chunked' })?.status).toBe(411)
  })

  it('Transfer-Encoding СТАРШЕ Content-Length (RFC 9112 §6.3)', () => {
    // Пара «оба заголовка сразу» — каноническая форма подмешивания второго запроса в поток:
    // `Content-Length: 0` с настоящим chunked-телом следом. Доверившись длине, мы пропустили бы его.
    // Сегодня такой запрос отвергает сам парсер Node, но это свойство ЧУЖОГО парсера, а функция
    // чистая и переиспользуемая — порядок обязан быть правильным здесь.
    expect(bodyLimitStatus({ contentLength: '0', transferEncoding: 'chunked' })?.status).toBe(411)
    expect(bodyLimitStatus({ contentLength: '10', transferEncoding: 'identity' })?.status).toBe(411)
  })

  it('длина в форме, которой нельзя верить, → 411, а не догадка', () => {
    // `Number()` проглотил бы каждую из этих строк и выдал число, разошедшееся с реальным телом.
    for (const raw of ['1e9', '0x10', '-1', '1.5', '', ' ', '10, 20', '12abc', '+7']) {
      expect(bodyLimitStatus({ contentLength: raw })?.status, JSON.stringify(raw)).toBe(411)
    }
  })

  it('потолок настраивается — роут может быть строже общего', () => {
    expect(bodyLimitStatus({ contentLength: '9000', limit: 8 * 1024 })?.status).toBe(413)
    expect(bodyLimitStatus({ contentLength: '8000', limit: 8 * 1024 })).toBeNull()
  })

  it('у отказа есть текст на русском — его увидит человек', () => {
    for (const v of [bodyLimitStatus({ contentLength: '99999999' }), bodyLimitStatus({ transferEncoding: 'chunked' })]) {
      expect(v?.error).toMatch(/[а-яё]/i)
      expect(v?.error.length).toBeGreaterThan(10)
    }
  })
})

/**
 * Поведение бэкстопа на ЖИВОМ HTTP.
 *
 * Раньше здесь стояли грепы по исходнику middleware, и они не ловили ничего существенного: мутация
 * `if (!verdict) return` → `if (verdict) return` выключала защиту целиком, а тесты оставались
 * зелёными. Греп проверяет, что строка написана; проверять надо, что запрос оборван.
 *
 * Поднимаем настоящий h3-app с тем же порядком слоёв, что у Nitro (middleware → роут), и настоящий
 * `node:http`. Так одновременно проверяется допущение, на котором держится весь файл: возврат
 * значения из middleware ЗАВЕРШАЕТ запрос и до роута дело не доходит.
 */
describe('бэкстоп на живом HTTP', () => {
  let app: App
  let server: Server
  let base: string
  let port = 0
  /** Сюда роут пишет свои вызовы: пустой массив = запрос до роутов не дошёл. */
  const reached: string[] = []

  beforeAll(async () => {
    app = createApp()
    app.use(defineEventHandler(handleBodyLimit))
    app.use(defineEventHandler((event) => {
      reached.push(event.path ?? '?')
      return { ok: true, marker: 'роут выполнился' }
    }))
    server = createServer(toNodeListener(app))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    port = typeof addr === 'object' && addr ? addr.port : 0
    base = `http://127.0.0.1:${port}`
  })

  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  /**
   * Сырой сокет вместо `fetch`: undici отказывается отправить `Content-Length`, не совпадающий с
   * телом, — а именно так и поступает атакующий (заявляет много, шлёт по чуть-чуть). Заодно это
   * единственный способ послать `Transfer-Encoding` ровно в том виде, в каком мы его проверяем.
   */
  const raw = (path: string, headers: string, body = 'x') =>
    new Promise<{ status: number, head: string, body: string }>((resolve, reject) => {
      const s = netConnect(port, '127.0.0.1', () => {
        s.write(`POST ${path} HTTP/1.1\r\nHost: t\r\n${headers}\r\n${body}`)
      })
      let buf = ''
      s.on('data', (d) => { buf += String(d) })
      s.on('error', reject)
      const finish = () => {
        const [head = '', ...rest] = buf.split('\r\n\r\n')
        resolve({ status: Number(head.split(' ')[1] ?? 0), head, body: rest.join('\r\n\r\n') })
      }
      s.on('close', finish)
      // Соединение с `keep-alive` не закроется само — отвечаем, как только пришла голова ответа.
      setTimeout(() => { if (buf) { finish(); s.destroy() } }, 250)
    })

  it('тело сверх потолка → 413, и роут НЕ выполнился', async () => {
    reached.length = 0
    const res = await raw('/api/b24/deal-update', 'Content-Length: 99999999\r\n')
    expect(res.status).toBe(413)
    expect(res.body).toContain('Слишком большой')
    expect(reached, 'запрос дошёл до роута — бэкстоп не оборвал цепочку').toEqual([])
  })

  it('соединение закрывается — иначе отправитель дольёт остаток в никуда', async () => {
    // Node после ответа вычитывает остаток тела (`req._dump()`), и отправитель, игнорирующий ранний
    // ответ, спокойно заливает заявленные сотни мегабайт. Память цела, но канал и CPU сжигаются.
    const res = await raw('/api/submit', 'Content-Length: 99999999\r\n')
    expect(res.head.toLowerCase()).toContain('connection: close')
  })

  it('тело без заявленной длины → 411, и роут НЕ выполнился', async () => {
    reached.length = 0
    const res = await raw('/api/b24/install', 'Transfer-Encoding: chunked\r\n', '1\r\nx\r\n0\r\n\r\n')
    expect(res.status).toBe(411)
    expect(reached).toEqual([])
  })

  it('запрос в пределах потолка доходит до роута', async () => {
    reached.length = 0
    const res = await raw('/api/b24/deal-update', 'Content-Length: 1\r\n')
    expect(res.status).toBe(200)
    expect(res.body).toContain('роут выполнился')
    expect(reached).toEqual(['/api/b24/deal-update'])
  })

  it('GET без тела проходит насквозь', async () => {
    reached.length = 0
    const res = await fetch(`${base}/s/demo`)
    expect(res.status).toBe(200)
    expect(reached).toEqual(['/s/demo'])
  })

  it('маршрут НЕ влияет на вердикт — иначе бэкстоп снова станет поимённым', async () => {
    // Именно так его и обошли бы незаметно: `if (/^\/api\/b24\//.test(url)) return` выводит
    // из-под защиты ровно те три вебхука, ради которых всё написано.
    const paths = ['/api/b24/install', '/api/b24/deal-update', '/api/b24/robot', '/api/b24/deal-invite',
      '/api/submit', '/api/feedback', '/api/admin/surveys/x/publish', '/', '/s/x', '/nope', '/favicon.svg']
    reached.length = 0
    for (const p of paths) {
      const res = await raw(p, 'Content-Length: 99999999\r\n')
      expect(res.status, `${p}: вердикт разошёлся с остальными`).toBe(413)
    }
    expect(reached, 'какой-то маршрут прошёл мимо бэкстопа').toEqual([])
  })
})

/**
 * Гард на поимённые капы роутов: кап сверх бэкстопа — обещание, которого роут выполнить не может,
 * запрос отсечётся раньше, чем дойдёт до него.
 */
describe('капы роутов согласованы с общим потолком', () => {
  it('ни один роут не объявляет кап больше общего потолка', () => {
    const caps = routeCaps()
    // Пиннем КОЛИЧЕСТВО: иначе переименование константы или её удаление тихо выводит роут
    // из-под гарда, и он остаётся зелёным, ничего уже не проверяя.
    expect(caps.map((c) => c.file.replace(/.*server\/api\//, '')).sort()).toEqual([
      'admin/surveys/[key]/publish.post.ts',
      'b24/session.post.ts',
      'feedback.post.ts',
      'submit.post.ts'
    ])
    for (const c of caps) {
      expect(c.value, `${c.file}: кап ${c.raw} больше общего потолка`).toBeLessThanOrEqual(MAX_REQUEST_BODY_BYTES)
    }
  })
})

interface RouteCap { file: string, raw: string, value: number }

/**
 * Собрать капы из роутов.
 *
 * ⚠️ Выражение, которое не удалось разобрать, — это КРАСНЫЙ тест, а не пропуск. Прежняя версия
 * обрывалась на первом непонятном символе и отдавала огрызок: `1_000_000` превращалось в `1`,
 * `0x100000` — в `0`. Гард рапортовал об успехе на входе, которого не понял, — худший режим отказа.
 */
function routeCaps(): RouteCap[] {
  const caps: RouteCap[] = []
  for (const file of listFiles(join(ROOT, 'server/api'))) {
    for (const m of readFileSync(file, 'utf8').matchAll(/MAX_BODY_BYTES\s*=\s*([^\n]+)/g)) {
      const raw = (m[1] ?? '').trim()
      if (!/^\d+(\s*\*\s*\d+)*$/.test(raw)) {
        throw new Error(`${file}: кап «${raw}» записан в форме, которую гард не умеет проверять`)
      }
      caps.push({ file, raw, value: raw.split('*').reduce((a, p) => a * Number(p.trim()), 1) })
    }
  }
  return caps
}

function listFiles(dir: string): string[] {
      // ⚠️ Пробы линт-гейта (`__lint-probe.*`) исключаем: `test/lint-gate.test.ts` пишет их в
      // боевые каталоги и удаляет сразу же. Между сбором списка и чтением файла есть окно, в
      // которое проба успевает исчезнуть — тогда чтение падало бы `ENOENT` в ЧУЖОМ тесте, с
      // сообщением, по которому причину не найти. Ревью воспроизвело это детерминированно.
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? listFiles(join(dir, e.name))
      : e.name.endsWith('.ts') && !e.name.startsWith('__lint-probe') ? [join(dir, e.name)] : []
  )
}
