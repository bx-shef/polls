import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Api, ApiResult } from '../api/handlers'
import { nullLogger, type Logger } from '../obs/logger'

/**
 * Минимальный HTTP-адаптер на node:http (нулевые зависимости): роутинг
 * эндпоинтов (session/survey/submit/health), лимит тела, разбор JSON, таймаут
 * запроса (анти-slowloris).
 * Прод-адаптером может быть Nitro (фаза связки) — хендлеры (`createApi`) от
 * рантайма не зависят. Модуль НЕ экспортируется из barrel (src/index.ts),
 * чтобы ядро не тянуло node:http: импортируйте напрямую из 'src/server/node'.
 *
 * IP берётся из сокета: за reverse-proxy (фаза деплоя) адаптер должен сам
 * решить вопрос доверия X-Forwarded-For — здесь заголовки НЕ читаются.
 */
export interface NodeServerOptions {
  api: Api
  /** 0 (по умолчанию) — слушать на свободном порту (удобно тестам). */
  port?: number
  host?: string
  /** Лимит тела запроса; больше → 413 + закрытие соединения. */
  maxBodyBytes?: number
  /** Максимум на весь запрос, мс (анти-slowloris; default 30с). */
  requestTimeoutMs?: number
  /** Структурный логгер запросов (#5). Default `nullLogger` (тихая библиотека). */
  logger?: Logger
}

export interface NodeServer {
  port: number
  close(): Promise<void>
}

// ── маленькие чистые helpers (экспортированы для unit-тестов) ──

export function ipOf(req: Pick<IncomingMessage, 'socket'>): string {
  return req.socket.remoteAddress ?? 'unknown'
}

export function pathOf(rawUrl: string | undefined): string {
  const raw = rawUrl ?? ''
  const q = raw.indexOf('?')
  return q === -1 ? raw : raw.slice(0, q)
}

export function portOf(addr: ReturnType<Server['address']>): number {
  return typeof addr === 'object' && addr !== null ? addr.port : 0
}

/**
 * `/api/survey/:key/current` → декодированный ключ (или null, если путь не подходит).
 * Сегмент-ключ декодируем (`decodeURIComponent`); валидацию формы делает хендлер.
 */
export function surveyKeyFromPath(url: string): string | null {
  const m = /^\/api\/survey\/([^/]+)\/current$/.exec(url)
  if (!m || m[1] === undefined) return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    return null // битый percent-encoding (URIError) → не наш ключ (предсказуемо, как и пустой сегмент)
  }
}

function send(res: ServerResponse, r: ApiResult, opts: { closeConn?: boolean; headOnly?: boolean } = {}): void {
  res.writeHead(r.status, {
    'content-type': 'application/json; charset=utf-8',
    ...(opts.closeConn ? { connection: 'close' } : {})
  })
  res.end(opts.headOnly ? undefined : JSON.stringify(r.body)) // HEAD: статус+заголовки без тела (RFC 9110)
}

/** null = превышен лимит тела (вызывающий отвечает 413 и закрывает соединение). */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        req.removeAllListeners('data')
        req.removeAllListeners('end')
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject) // reject после resolve — безопасный no-op
  })
}

async function route(api: Api, req: IncomingMessage, res: ServerResponse, maxBodyBytes: number): Promise<void> {
  const ip = ipOf(req)
  const url = pathOf(req.url)

  if (url === '/api/health') {
    // Публичный, без rate-limit: оркестратор/reverse-proxy опрашивает часто.
    if (req.method !== 'GET') return send(res, { status: 405, body: { ok: false, error: 'Метод не поддерживается' } })
    return send(res, await api.health())
  }

  if (url === '/api/session') {
    if (req.method !== 'GET') return send(res, { status: 405, body: { ok: false, error: 'Метод не поддерживается' } })
    return send(res, await api.session({ ip }))
  }

  const surveyKey = surveyKeyFromPath(url)
  if (surveyKey !== null) {
    // HEAD ведём как GET (прокси/браузеры зондируют им), но без тела ответа.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, { status: 405, body: { ok: false, error: 'Метод не поддерживается' } })
    }
    return send(res, await api.survey({ ip, surveyKey }), { headOnly: req.method === 'HEAD' })
  }

  if (url === '/api/submit') {
    if (req.method !== 'POST') return send(res, { status: 405, body: { ok: false, error: 'Метод не поддерживается' } })
    const raw = await readBody(req, maxBodyBytes)
    if (raw === null) {
      // connection: close — соединение завершится после ответа, остаток тела не читаем
      return send(res, { status: 413, body: { ok: false, error: 'Слишком большой запрос' } }, { closeConn: true })
    }
    let body: unknown
    try {
      body = JSON.parse(raw)
    } catch {
      return send(res, { status: 400, body: { ok: false, error: 'Некорректный JSON' } })
    }
    return send(res, await api.submit({ ip, body }))
  }

  send(res, { status: 404, body: { ok: false, error: 'Не найдено' } })
}

/** Аварийный ответ при необработанной ошибке роутинга (экспорт — для unit-теста). */
export function failSafe(res: Pick<ServerResponse, 'headersSent' | 'writeHead' | 'end' | 'destroy'>): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: false, error: 'Внутренняя ошибка' }))
}

export function startServer(opts: NodeServerOptions): Promise<NodeServer> {
  const maxBodyBytes = opts.maxBodyBytes ?? 64 * 1024
  const logger = opts.logger ?? nullLogger
  const server = createServer((req, res) => {
    const requestId = randomUUID()
    const startedAt = Date.now()
    res.setHeader('x-request-id', requestId) // корреляция лог↔клиент (лёгкий seam под трейсы)
    // async-роутинг с перехватом: необработанный reject уронил бы процесс (Node ≥15)
    route(opts.api, req, res, maxBodyBytes)
      .catch(() => failSafe(res))
      .finally(() => {
        const fields = {
          requestId,
          method: req.method,
          path: pathOf(req.url),
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
          ip: ipOf(req)
        }
        if (res.statusCode >= 500) logger.error('request', fields)
        else if (res.statusCode >= 400) logger.warn('request', fields) // 4xx (429/409/422) видны в warn
        else logger.info('request', fields)
      })
  })
  server.requestTimeout = opts.requestTimeoutMs ?? 30_000
  server.headersTimeout = Math.min(10_000, server.requestTimeout)

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      resolve({
        port: portOf(server.address()),
        close: () =>
          new Promise<void>((res2, rej2) => {
            server.closeAllConnections() // иначе keep-alive соединения держат close()
            server.close((e) => (e ? rej2(e) : res2()))
          })
      })
    })
  })
}
