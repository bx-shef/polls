import { describe, expect, it, vi } from 'vitest'
import {
  createJsonLogger,
  errInfo,
  nullLogger,
  redact,
  type JsonLoggerOptions,
  type LogFields,
  type Logger,
  type LogLevel
} from '../src/obs/logger'
import { installProcessHandlers, type ProcessLike } from '../src/obs/process'

/**
 * Наблюдаемость (#5): структурный логгер + редакция секретов + process-хуки.
 * Редакция — security-критична («секреты не светятся» из issue), поэтому
 * покрыта плотно: вложенность, массивы, регистр, циклы, глубина.
 */

const FIXED = '2026-06-14T00:00:00.000Z'

/** Логгер с захватом разобранных JSON-строк (level='debug' — ничего не режется). */
function captureJson(opts: Partial<JsonLoggerOptions> = {}): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = []
  const logger = createJsonLogger({
    level: 'debug',
    now: () => new Date(FIXED),
    sink: (_l, line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    ...opts
  })
  return { logger, lines }
}

/** Логгер, записывающий (level, msg, fields) — для проверки вызовов из process-хуков. */
function recordingLogger(): { logger: Logger; calls: { level: LogLevel; msg: string; fields?: LogFields }[] } {
  const calls: { level: LogLevel; msg: string; fields?: LogFields }[] = []
  const mk =
    (level: LogLevel) =>
    (msg: string, fields?: LogFields): void =>
      void calls.push({ level, msg, fields })
  const logger: Logger = { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error'), child: () => logger }
  return { logger, calls }
}

/** Фейковый process: копит слушателей по имени события и коды exit(). */
function fakeProcess(): { proc: ProcessLike; emit: (event: string, arg: unknown) => void; exits: number[] } {
  const listeners: Record<string, ((arg: unknown) => void)[]> = {}
  const exits: number[] = []
  const proc = {
    on(event: string, listener: (arg: unknown) => void) {
      ;(listeners[event] ??= []).push(listener)
      return proc
    },
    exit(code: number): never {
      exits.push(code)
      return undefined as never
    }
  }
  return { proc: proc as unknown as ProcessLike, emit: (e, a) => (listeners[e] ?? []).forEach((l) => l(a)), exits }
}

describe('createJsonLogger', () => {
  it('пишет одну JSON-строку: level/time/msg + поля', () => {
    const { logger, lines } = captureJson()
    logger.info('hello', { a: 1, b: 'two' })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toEqual({ level: 'info', time: FIXED, msg: 'hello', a: 1, b: 'two' })
  })

  it('фильтрует по уровню: level=warn режет debug/info', () => {
    const { logger, lines } = captureJson({ level: 'warn' })
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')
    expect(lines.map((l) => l['msg'])).toEqual(['w', 'e'])
  })

  it('base-поля примешиваются; child() добавляет свои', () => {
    const { logger, lines } = captureJson({ base: { svc: 'polls' } })
    logger.child({ reqId: 'r1' }).info('hit', { extra: 1 })
    expect(lines[0]).toMatchObject({ svc: 'polls', reqId: 'r1', extra: 1, msg: 'hit' })
  })

  it('зарезервированные level/time/msg не перетираются из fields', () => {
    const { logger, lines } = captureJson()
    logger.warn('real', { level: 'debug', time: 'fake', msg: 'fake', ok: 1 })
    expect(lines[0]).toMatchObject({ level: 'warn', time: FIXED, msg: 'real', ok: 1 })
  })

  it('редактирует секреты прямо в записи лога', () => {
    const { logger, lines } = captureJson()
    logger.info('oauth', { access_token: 'AAA', surveyKey: 'svc' })
    expect(lines[0]?.['access_token']).toBe('[REDACTED]')
    expect(lines[0]?.['surveyKey']).toBe('svc')
  })

  it('секрет в base редактируется в каждой записи', () => {
    const { logger, lines } = captureJson({ base: { token: 'xyz', svc: 'polls' } })
    logger.info('hit')
    expect(lines[0]?.['token']).toBe('[REDACTED]')
    expect(lines[0]?.['svc']).toBe('polls')
  })

  it('уровень берётся из env LOG_LEVEL; мусор → info', () => {
    const saved = process.env['LOG_LEVEL']
    try {
      process.env['LOG_LEVEL'] = 'error'
      const a: Record<string, unknown>[] = []
      const la = createJsonLogger({ now: () => new Date(FIXED), sink: (_l, line) => a.push(JSON.parse(line)) })
      la.info('i')
      la.error('e')
      expect(a.map((l) => l['msg'])).toEqual(['e'])

      process.env['LOG_LEVEL'] = 'нонсенс'
      const b: Record<string, unknown>[] = []
      const lb = createJsonLogger({ now: () => new Date(FIXED), sink: (_l, line) => b.push(JSON.parse(line)) })
      lb.debug('d')
      lb.info('i2')
      expect(b.map((l) => l['msg'])).toEqual(['i2'])
    } finally {
      if (saved === undefined) delete process.env['LOG_LEVEL']
      else process.env['LOG_LEVEL'] = saved
    }
  })

  it('дефолты: реальные часы (now не задан) + уровень из NUXT_LOG_LEVEL', () => {
    const saved = { log: process.env['LOG_LEVEL'], nuxt: process.env['NUXT_LOG_LEVEL'] }
    try {
      delete process.env['LOG_LEVEL']
      process.env['NUXT_LOG_LEVEL'] = 'warn'
      const lines: Record<string, unknown>[] = []
      const logger = createJsonLogger({ sink: (_l, line) => lines.push(JSON.parse(line)) }) // now — по умолчанию
      logger.info('i') // ниже warn → молчит
      logger.warn('w')
      expect(lines.map((l) => l['msg'])).toEqual(['w'])
      expect(Number.isNaN(Date.parse(String(lines[0]?.['time'])))).toBe(false) // реальный ISO
    } finally {
      if (saved.log === undefined) delete process.env['LOG_LEVEL']
      else process.env['LOG_LEVEL'] = saved.log
      if (saved.nuxt === undefined) delete process.env['NUXT_LOG_LEVEL']
      else process.env['NUXT_LOG_LEVEL'] = saved.nuxt
    }
  })

  it('дефолтный sink: info → stdout, error → stderr', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const errOut = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const logger = createJsonLogger({ level: 'debug', now: () => new Date(FIXED) })
      logger.info('i')
      logger.error('e')
      expect(out).toHaveBeenCalledTimes(1)
      expect(errOut).toHaveBeenCalledTimes(1)
    } finally {
      out.mockRestore()
      errOut.mockRestore()
    }
  })
})

describe('redact', () => {
  it('маскирует секретные ключи (регистронезависимо), не трогая доменные', () => {
    const out = redact({
      access_token: 'AAA',
      refreshToken: 'BBB',
      tokens: { a: 1 },
      client_secret: 'CS',
      Authorization: 'Bearer x',
      cookie: 'sid=1',
      signature: 'sig',
      password: 'p',
      nonce: 'n',
      API_KEY: 'k',
      surveyKey: 'svc',
      questionKey: 'q_nps',
      optionKey: 'opt_1',
      portalId: 42,
      nested: { secretValue: 'z', ok: 'visible' },
      list: [{ token: 't' }, 'plain']
    }) as Record<string, unknown>
    for (const k of ['access_token', 'refreshToken', 'tokens', 'client_secret', 'Authorization', 'cookie', 'signature', 'password', 'nonce', 'API_KEY']) {
      expect(out[k]).toBe('[REDACTED]')
    }
    // доменные идентификаторы целы (в них есть «Key», но это не секрет)
    expect(out['surveyKey']).toBe('svc')
    expect(out['questionKey']).toBe('q_nps')
    expect(out['optionKey']).toBe('opt_1')
    expect(out['portalId']).toBe(42)
    expect((out['nested'] as Record<string, unknown>)['secretValue']).toBe('[REDACTED]')
    expect((out['nested'] as Record<string, unknown>)['ok']).toBe('visible')
    const list = out['list'] as unknown[]
    expect((list[0] as Record<string, unknown>)['token']).toBe('[REDACTED]')
    expect(list[1]).toBe('plain')
  })

  it('защита от циклов; DAG (общая ссылка) циклом НЕ считается', () => {
    const cyc: Record<string, unknown> = { a: 1 }
    cyc['self'] = cyc
    expect((redact(cyc) as Record<string, unknown>)['self']).toBe('[Circular]')

    const shared = { v: 1 }
    const dag = redact({ x: shared, y: shared }) as Record<string, unknown>
    expect(dag['x']).toEqual({ v: 1 })
    expect(dag['y']).toEqual({ v: 1 })
  })

  it('ограничивает глубину и длину строк; примитивы — как есть', () => {
    let deep: unknown = 'leaf'
    for (let i = 0; i < 12; i++) deep = { d: deep }
    expect(JSON.stringify(redact(deep))).toMatch(/\[Truncated\]/)

    expect(redact('x'.repeat(10_005))).toBe(`${'x'.repeat(10_000)}…[truncated]`)
    expect(redact('x'.repeat(10_000))).toBe('x'.repeat(10_000)) // ровно на границе — НЕ усечена
    expect(redact(5)).toBe(5)
    expect(redact(null)).toBe(null)
    expect(redact(undefined)).toBe(undefined)
    expect(redact(true)).toBe(true)
  })
})

describe('errInfo', () => {
  it('Error → name/message/stack; не-Error → message строкой', () => {
    const e = errInfo(new TypeError('boom'))
    expect(e['name']).toBe('TypeError')
    expect(e['message']).toBe('boom')
    expect(typeof e['stack']).toBe('string')
    expect(errInfo('строка')).toEqual({ message: 'строка' })
    expect(errInfo(42)).toEqual({ message: '42' })
    const noStack = new Error('x')
    delete (noStack as { stack?: string }).stack
    expect(errInfo(noStack)['stack']).toBeUndefined() // ветка stack=undefined
  })

  it('чистит креды строки подключения в message', () => {
    const e = errInfo(new Error('connect failed: postgres://app:s3cr3t@db:5432/polls'))
    expect(e['message']).not.toMatch(/s3cr3t/)
    expect(e['message']).toMatch(/postgres:\/\/app:\[REDACTED\]@db/)
  })
})

describe('nullLogger', () => {
  it('молчит, не падает; child → сам себя', () => {
    expect(() => {
      nullLogger.debug('a')
      nullLogger.info('b')
      nullLogger.warn('c')
      nullLogger.error('d', { x: 1 })
    }).not.toThrow()
    expect(nullLogger.child({ a: 1 })).toBe(nullLogger)
  })
})

describe('installProcessHandlers', () => {
  it('unhandledRejection → лог + onFatal, процесс НЕ валится', () => {
    const { logger, calls } = recordingLogger()
    const f = fakeProcess()
    const fatal: [string, unknown][] = []
    installProcessHandlers({ logger, process: f.proc, onFatal: (k, e) => fatal.push([k, e]) })
    f.emit('unhandledRejection', new Error('rej'))
    expect(calls[0]?.level).toBe('error')
    expect(calls[0]?.msg).toBe('unhandledRejection')
    expect((calls[0]?.fields?.['err'] as Record<string, unknown>)['message']).toBe('rej')
    expect(fatal).toEqual([['unhandledRejection', expect.any(Error)]])
    expect(f.exits).toEqual([])
  })

  it('uncaughtException → лог + onFatal + exit(1) по умолчанию', () => {
    const { logger, calls } = recordingLogger()
    const f = fakeProcess()
    const fatal: string[] = []
    installProcessHandlers({ logger, process: f.proc, onFatal: (k) => fatal.push(k) })
    f.emit('uncaughtException', new Error('boom'))
    expect(calls[0]?.level).toBe('error')
    expect(calls[0]?.msg).toBe('uncaughtException')
    expect(fatal).toEqual(['uncaughtException'])
    expect(f.exits).toEqual([1])
  })

  it('exitOnUncaught:false → без exit', () => {
    const { logger } = recordingLogger()
    const f = fakeProcess()
    installProcessHandlers({ logger, process: f.proc, exitOnUncaught: false })
    f.emit('uncaughtException', new Error('boom'))
    expect(f.exits).toEqual([])
  })

  it('без process (не-node рантайм) — тихий no-op', () => {
    const { logger, calls } = recordingLogger()
    const holder = globalThis as { process?: unknown }
    const saved = holder.process
    holder.process = undefined
    try {
      expect(() => installProcessHandlers({ logger })).not.toThrow()
      expect(calls).toHaveLength(0)
    } finally {
      holder.process = saved
    }
  })
})
