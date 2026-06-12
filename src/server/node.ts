import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Api, ApiResult } from '../api/handlers'

/**
 * Минимальный HTTP-адаптер на node:http (нулевые зависимости): роутинг двух
 * эндпоинтов, лимит тела, разбор JSON. Прод-адаптером может быть Nitro (фаза
 * связки) — хендлеры (`createApi`) от рантайма не зависят.
 *
 * IP берётся из сокета: за reverse-proxy (фаза деплоя) адаптер должен сам
 * решить вопрос доверия X-Forwarded-For — здесь заголовки НЕ читаются.
 */
export interface NodeServerOptions {
  api: Api
  /** 0 (по умолчанию) — слушать на свободном порту (удобно тестам). */
  port?: number
  host?: string
  /** Лимит тела запроса; больше → 413 (защита от раздувания). */
  maxBodyBytes?: number
}

export interface NodeServer {
  port: number
  close(): Promise<void>
}

function send(res: ServerResponse, r: ApiResult): void {
  const payload = JSON.stringify(r.body)
  res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  // null = превышен лимит (тело дочитывать бессмысленно)
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
    req.on('error', reject)
  })
}

export function startServer(opts: NodeServerOptions): Promise<NodeServer> {
  const maxBodyBytes = opts.maxBodyBytes ?? 64 * 1024
  const server = createServer(async (req, res) => {
    const ip = req.socket.remoteAddress ?? 'unknown'
    const url = (req.url ?? '').split('?')[0]

    if (url === '/api/session') {
      if (req.method !== 'GET') return send(res, { status: 405, body: { ok: false, error: 'Метод не поддерживается' } })
      return send(res, await opts.api.session({ ip }))
    }

    if (url === '/api/submit') {
      if (req.method !== 'POST') return send(res, { status: 405, body: { ok: false, error: 'Метод не поддерживается' } })
      const raw = await readBody(req, maxBodyBytes)
      if (raw === null) return send(res, { status: 413, body: { ok: false, error: 'Слишком большой запрос' } })
      let body: unknown
      try {
        body = JSON.parse(raw)
      } catch {
        return send(res, { status: 400, body: { ok: false, error: 'Некорректный JSON' } })
      }
      return send(res, await opts.api.submit({ ip, body }))
    }

    send(res, { status: 404, body: { ok: false, error: 'Не найдено' } })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0
      resolve({
        port,
        close: () =>
          new Promise<void>((res2, rej2) => server.close((e) => (e ? rej2(e) : res2())))
      })
    })
  })
}
