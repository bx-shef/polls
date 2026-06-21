import { describe, expect, it } from 'vitest'
import { createApi, SUPPORTED_SCHEMA_VERSION, type Api } from '../src/api/handlers'
import { nullLogger } from '../src/obs/logger'
import { MemoryNonceStore } from '../src/api/nonce'
import { MemoryInvitationStore } from '../src/api/invitation'
import { SlidingWindowLimiter } from '../src/api/ratelimit'
import { MemoryStore } from '../src/store/memory'
import { buildDemo, SURVEY_KEY } from '../src/demo/seed'

/** Управляемые часы: детерминированные TTL/окна без таймеров. */
function clock(startIso = '2026-06-12T10:00:00.000Z'): { now: () => Date; advance: (ms: number) => void } {
  let t = new Date(startIso).getTime()
  return { now: () => new Date(t), advance: (ms) => (t += ms) }
}

async function freshApi(over: Partial<Parameters<typeof createApi>[0]> = {}): Promise<{
  api: Api
  store: MemoryStore
  now: () => Date
  advance: (ms: number) => void
}> {
  const store = await buildDemo(new MemoryStore())
  const c = clock()
  const api = createApi({ store, now: c.now, idGen: () => 'srv-id-1', ...over })
  return { api, store, now: c.now, advance: c.advance }
}

/** Валидный payload на версию 2 демо-опроса (все обязательные вопросы отвечены). */
function validPayload(nonce: string): Record<string, unknown> {
  return {
    schema_version: SUPPORTED_SCHEMA_VERSION,
    nonce,
    hp: '',
    surveyKey: SURVEY_KEY,
    versionNo: 2,
    answers: {
      q_nps: { values: ['n9'] },
      q_csat: { values: ['s4'] },
      q_liked: { values: ['speed'] }
    }
  }
}

async function issueNonce(api: Api, ip = '10.0.0.1'): Promise<string> {
  const s = await api.session({ ip })
  expect(s.status).toBe(200)
  return s.body['nonce'] as string
}

describe('GET /api/session', () => {
  it('выдаёт nonce + schema_version (bootstrap клиента, brief §8)', async () => {
    const { api } = await freshApi()
    const r = await api.session({ ip: 'a' })
    expect(r.status).toBe(200)
    expect(r.body['nonce']).toBeTruthy()
    expect(r.body['schema_version']).toBe(SUPPORTED_SCHEMA_VERSION)
  })

  it('выдаёт nonce; флуд по IP режется rate-limit (429)', async () => {
    const { api } = await freshApi({ limiter: new SlidingWindowLimiter({ limit: 2, windowMs: 60_000 }) })
    expect((await api.session({ ip: 'a' })).status).toBe(200)
    expect((await api.session({ ip: 'a' })).status).toBe(200)
    expect((await api.session({ ip: 'a' })).status).toBe(429)
    expect((await api.session({ ip: 'b' })).status).toBe(200) // другой IP — свой бюджет
  })

  it('переполнение nonce-стора → 503 (защита памяти)', async () => {
    const { api } = await freshApi({ nonces: new MemoryNonceStore({ maxPending: 1 }) })
    expect((await api.session({ ip: 'a' })).status).toBe(200)
    expect((await api.session({ ip: 'b' })).status).toBe(503)
  })
})

describe('GET /api/survey/:key/current (контур A)', () => {
  /** Демо-стор, в котором currentVersion возвращает версию с презентацией и invitationPolicy. */
  async function storeWithPresentation(): Promise<MemoryStore> {
    const base = await buildDemo(new MemoryStore())
    return new (class extends MemoryStore {
      override async currentVersion(k: string) {
        const v = await base.currentVersion(k)
        if (!v) return undefined
        return {
          ...v,
          intro: { title: 'Здравствуйте', meta: ['Анонимно'] },
          thanks: { title: 'Спасибо!' },
          blocks: ['О сделке', 'Команда'],
          invitationPolicy: { entityType: 'deal' as const, triggerStages: ['DEAL:WON'], channelOrder: ['email' as const] }
        }
      }
    })()
  }

  it('отдаёт текущую версию с презентацией и вопросами, БЕЗ invitationPolicy', async () => {
    const api = createApi({ store: await storeWithPresentation() })
    const r = await api.survey({ ip: 'a', surveyKey: SURVEY_KEY })
    expect(r.status).toBe(200)
    expect(r.body['ok']).toBe(true)
    expect(r.body['schema_version']).toBe(SUPPORTED_SCHEMA_VERSION)
    const version = r.body['version'] as Record<string, unknown>
    expect(version['surveyKey']).toBe(SURVEY_KEY)
    expect((version['intro'] as Record<string, unknown>)['title']).toBe('Здравствуйте')
    expect(version['blocks']).toEqual(['О сделке', 'Команда'])
    expect((version['thanks'] as Record<string, unknown>)['title']).toBe('Спасибо!')
    expect(Array.isArray(version['questions'])).toBe(true)
    expect(version['invitationPolicy']).toBeUndefined() // внутренняя CRM-конфигурация не утекает
  })

  it('неизвестный опрос → 404', async () => {
    const { api } = await freshApi()
    const r = await api.survey({ ip: 'a', surveyKey: 'no_such_survey' })
    expect(r.status).toBe(404)
  })

  it('некорректный ключ (слишком длинный / пустой) → 400', async () => {
    const { api } = await freshApi()
    expect((await api.survey({ ip: 'a', surveyKey: 'x'.repeat(201) })).status).toBe(400)
    expect((await api.survey({ ip: 'a', surveyKey: '' })).status).toBe(400) // контракт хендлера, независимо от роутера
  })

  it('флуд по IP режется rate-limit (429)', async () => {
    const { api } = await freshApi({ limiter: new SlidingWindowLimiter({ limit: 1, windowMs: 60_000 }) })
    expect((await api.survey({ ip: 'a', surveyKey: SURVEY_KEY })).status).toBe(200)
    expect((await api.survey({ ip: 'a', surveyKey: SURVEY_KEY })).status).toBe(429)
    expect((await api.survey({ ip: 'b', surveyKey: SURVEY_KEY })).status).toBe(200) // другой IP — свой бюджет
  })

  it('падение store → 500 (детали наружу не отдаём)', async () => {
    const store = new (class extends MemoryStore {
      override async currentVersion(): Promise<never> {
        throw new Error('db down')
      }
    })()
    const r = await createApi({ store, logger: nullLogger }).survey({ ip: 'a', surveyKey: SURVEY_KEY })
    expect(r.status).toBe(500)
    expect(r.body['error']).not.toContain('db down')
  })
})

describe('POST /api/submit — конвейер проверок', () => {
  it('happy path: 200, запись с СЕРВЕРНЫМИ id/submittedAt и пустым context', async () => {
    const { api, store, now } = await freshApi()
    const nonce = await issueNonce(api)
    const payload = {
      ...validPayload(nonce),
      // попытка подделки: сервер обязан игнорировать клиентские поля записи
      id: 'hacker-id',
      submittedAt: '1999-01-01T00:00:00.000Z',
      context: { companyId: 999999 }
    }
    const r = await api.submit({ ip: '10.0.0.1', body: payload })
    expect(r).toEqual({ status: 200, body: { ok: true } })
    const saved = (await store.listResponses()).at(-1)!
    expect(saved.id).toBe('srv-id-1') // серверный idGen
    expect(saved.submittedAt).toBe(now().toISOString()) // серверные часы (#4)
    expect(saved.context).toEqual({}) // контекст не принимается от клиента
    expect(saved.answers.find((a) => a.questionKey === 'q_nps')?.valueNumber).toBe(9)
  })

  it('honeypot: непустой hp → 400 generic, ДО любых других проверок', async () => {
    const { api } = await freshApi({ limiter: new SlidingWindowLimiter({ limit: 0, windowMs: 60_000 }) })
    // лимит 0 дал бы 429 — но honeypot срабатывает раньше
    const r = await api.submit({ ip: 'bot', body: { hp: 'gotcha' } })
    expect(r.status).toBe(400)
    expect(r.body['error']).toBe('Отклонено')
  })

  it('rate-limit по IP → 429; не делит бюджет с /session', async () => {
    const { api } = await freshApi({ limiter: new SlidingWindowLimiter({ limit: 1, windowMs: 60_000 }) })
    // 1-я попытка submit съедает бюджет p:ip (payload неважен — упадёт позже по форме)
    expect((await api.submit({ ip: 'x', body: {} })).status).toBe(400)
    expect((await api.submit({ ip: 'x', body: {} })).status).toBe(429)
  })

  it('кривая форма → 400; неподдерживаемая schema_version → 400 с пояснением', async () => {
    const { api } = await freshApi()
    expect((await api.submit({ ip: 'a', body: 'не объект' })).status).toBe(400)
    expect((await api.submit({ ip: 'a', body: { schema_version: 1 } })).status).toBe(400)
    const nonce = await issueNonce(api)
    const r = await api.submit({ ip: 'a', body: { ...validPayload(nonce), schema_version: 2 } })
    expect(r.status).toBe(400)
    expect(String(r.body['error'])).toMatch(/версия схемы: 2/)
  })

  it('nonce: повтор → 409, неизвестный → 403, протухший (TTL) → 403', async () => {
    const { api, advance } = await freshApi({ nonces: new MemoryNonceStore({ ttlMs: 1000 }) })
    const nonce = await issueNonce(api)
    expect((await api.submit({ ip: 'a', body: validPayload(nonce) })).status).toBe(200)
    expect((await api.submit({ ip: 'a', body: validPayload(nonce) })).status).toBe(409) // replay
    expect((await api.submit({ ip: 'a', body: validPayload('левый') })).status).toBe(403) // unknown
    const stale = await issueNonce(api)
    advance(1001) // nonce протух
    expect((await api.submit({ ip: 'a', body: validPayload(stale) })).status).toBe(403)
  })

  it('неизвестный опрос/версия → 404 (nonce уже потрачен — анти-перебор)', async () => {
    const { api } = await freshApi()
    const n1 = await issueNonce(api)
    expect((await api.submit({ ip: 'a', body: { ...validPayload(n1), surveyKey: 'нет' } })).status).toBe(404)
    const n2 = await issueNonce(api)
    expect((await api.submit({ ip: 'a', body: { ...validPayload(n2), versionNo: 99 } })).status).toBe(404)
  })

  it('ошибки валидации ответов → 422 { errors } (обязательный вопрос пропущен)', async () => {
    const { api } = await freshApi()
    const nonce = await issueNonce(api)
    const body = { ...validPayload(nonce), answers: { q_nps: { values: ['n9'] } } } // нет q_csat/q_liked
    const r = await api.submit({ ip: 'a', body })
    expect(r.status).toBe(422)
    expect(r.body['ok']).toBe(false)
    expect(Object.keys(r.body['errors'] as Record<string, string>)).toEqual(
      expect.arrayContaining(['q_csat', 'q_liked'])
    )
  })

  it('сбой стора → 500 без деталей наружу', async () => {
    const { api } = await freshApi({
      store: new (class extends MemoryStore {
        override async getVersion(): Promise<never> {
          throw new Error('БД упала: секретная строка подключения')
        }
      })()
    })
    const nonce = await issueNonce(api)
    const r = await api.submit({ ip: 'a', body: validPayload(nonce) })
    expect(r.status).toBe(500)
    expect(JSON.stringify(r.body)).not.toMatch(/секретная/)
  })

  it('text-вопрос: заполненный сохраняется (valueText), пропущенный необязательный — нет', async () => {
    const { api, store } = await freshApi()
    const n1 = await issueNonce(api)
    const withComment = { ...validPayload(n1) }
    ;(withComment['answers'] as Record<string, unknown>)['q_comment'] = { text: '  Отличный сервис  ' }
    expect((await api.submit({ ip: 'a', body: withComment })).status).toBe(200)
    const saved = (await store.listResponses()).at(-1)!
    expect(saved.answers.find((a) => a.questionKey === 'q_comment')?.valueText).toBe('Отличный сервис')

    const n2 = await issueNonce(api)
    expect((await api.submit({ ip: 'a', body: validPayload(n2) })).status).toBe(200) // без q_comment
    const saved2 = (await store.listResponses()).at(-1)!
    expect(saved2.answers.some((a) => a.questionKey === 'q_comment')).toBe(false)
  })

  it('hp из одних пробелов НЕ срабатывает как honeypot (trim)', async () => {
    const { api } = await freshApi()
    // кривое тело: если бы honeypot сработал — был бы generic «Отклонено»
    const r = await api.submit({ ip: 'a', body: { hp: '   ' } })
    expect(r.status).toBe(400)
    expect(r.body['error']).toBe('Некорректный запрос')
  })

  it('schema_version строкой ("1") → 400 (строгая форма)', async () => {
    const { api } = await freshApi()
    const nonce = await issueNonce(api)
    expect((await api.submit({ ip: 'a', body: { ...validPayload(nonce), schema_version: '1' } })).status).toBe(400)
  })

  it('больше 200 ответов в payload → 400 (.refine)', async () => {
    const { api } = await freshApi()
    const nonce = await issueNonce(api)
    const answers: Record<string, { values: string[] }> = {}
    for (let i = 0; i < 201; i++) answers[`q${i}`] = { values: ['a'] }
    expect((await api.submit({ ip: 'a', body: { ...validPayload(nonce), answers } })).status).toBe(400)
  })

  it('гонка: два параллельных submit с одним nonce → ровно один 200 и один 409', async () => {
    const { api } = await freshApi()
    const nonce = await issueNonce(api)
    const [a, b] = await Promise.all([
      api.submit({ ip: 'a', body: validPayload(nonce) }),
      api.submit({ ip: 'a', body: validPayload(nonce) })
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
  })

  it('onError получает исходную ошибку стора (хук для логгера #5)', async () => {
    const seen: unknown[] = []
    const { api } = await freshApi({
      store: new (class extends MemoryStore {
        override async getVersion(): Promise<never> {
          throw new Error('диагностика для логгера')
        }
      })(),
      onError: (e) => seen.push(e)
    })
    const nonce = await issueNonce(api)
    expect((await api.submit({ ip: 'a', body: validPayload(nonce) })).status).toBe(500)
    expect(seen).toHaveLength(1)
    expect(String(seen[0])).toMatch(/диагностика/)
  })

  it('дефолтные зависимости (реальные часы/uuid/лимитер) — happy path работает', async () => {
    const store = await buildDemo(new MemoryStore())
    const api = createApi({ store }) // всё по умолчанию
    const nonce = await issueNonce(api)
    expect((await api.submit({ ip: 'a', body: validPayload(nonce) })).status).toBe(200)
    const saved = (await store.listResponses()).at(-1)!
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/) // randomUUID
  })
})

describe('POST /api/submit — приглашение #3 (снимок CRM-контекста)', () => {
  const snapshot = { dealId: 5994, companyId: 3986, dealStageId: 'WON' }

  async function withInvitation(): Promise<{
    api: Api
    store: MemoryStore
    invitations: MemoryInvitationStore
    now: () => Date
  }> {
    const invitations = new MemoryInvitationStore({ idGen: () => 'inv-tok-1' })
    const base = await freshApi({ invitations })
    return { api: base.api, store: base.store, invitations, now: base.now }
  }

  it('валидный токен → 200; context записи = снимок из приглашения', async () => {
    const { api, store, invitations, now } = await withInvitation()
    const inv = invitations.create({ surveyKey: SURVEY_KEY, versionNo: 2, context: snapshot }, now())
    const nonce = await issueNonce(api)
    const r = await api.submit({ ip: 'a', body: { ...validPayload(nonce), invitation: inv.token } })
    expect(r.status).toBe(200)
    const saved = (await store.listResponses()).at(-1)!
    expect(saved.context).toEqual(snapshot)
    // токен приглашения проброшен в запись — durable-якорь идемпотентности стора (#3/#4)
    expect(saved.invitationToken).toBe(inv.token)
  })

  it('submit без приглашения → запись без invitationToken (дедуп не нужен)', async () => {
    const { api, store } = await freshApi()
    const nonce = await issueNonce(api)
    expect((await api.submit({ ip: 'a', body: validPayload(nonce) })).status).toBe(200)
    expect((await store.listResponses()).at(-1)!.invitationToken).toBeUndefined()
  })

  it('повторное использование приглашения → 409 (идемпотентность #4)', async () => {
    const { api, invitations, now } = await withInvitation()
    const inv = invitations.create({ surveyKey: SURVEY_KEY, versionNo: 2, context: snapshot }, now())
    const n1 = await issueNonce(api)
    expect((await api.submit({ ip: 'a', body: { ...validPayload(n1), invitation: inv.token } })).status).toBe(200)
    const n2 = await issueNonce(api)
    expect((await api.submit({ ip: 'a', body: { ...validPayload(n2), invitation: inv.token } })).status).toBe(409)
  })

  it('неизвестный/протухший токен → 403', async () => {
    const { api } = await withInvitation()
    const nonce = await issueNonce(api)
    const r = await api.submit({ ip: 'a', body: { ...validPayload(nonce), invitation: 'нет-такого' } })
    expect(r.status).toBe(403)
  })

  it('приглашение от другого опроса/версии → 409 (несоответствие пина)', async () => {
    const { api, invitations, now } = await withInvitation()
    // версия приглашения 1, а payload идёт на версию 2
    const inv = invitations.create({ surveyKey: SURVEY_KEY, versionNo: 1, context: snapshot }, now())
    const nonce = await issueNonce(api)
    const r = await api.submit({ ip: 'a', body: { ...validPayload(nonce), invitation: inv.token } })
    expect(r.status).toBe(409)
  })

  it('422 по ответам НЕ сжигает приглашение — можно дослать корректные', async () => {
    const { api, store, invitations, now } = await withInvitation()
    const inv = invitations.create({ surveyKey: SURVEY_KEY, versionNo: 2, context: snapshot }, now())
    const n1 = await issueNonce(api)
    const bad = { ...validPayload(n1), invitation: inv.token, answers: { q_nps: { values: ['n9'] } } }
    expect((await api.submit({ ip: 'a', body: bad })).status).toBe(422)
    // приглашение цело → корректный сабмит проходит и пишет снимок
    const n2 = await issueNonce(api)
    expect((await api.submit({ ip: 'a', body: { ...validPayload(n2), invitation: inv.token } })).status).toBe(200)
    expect((await store.listResponses()).at(-1)!.context).toEqual(snapshot)
  })

  it('приглашение от другого ОПРОСА → 409 (сверка surveyKey, не только версии)', async () => {
    const { api, invitations, now } = await withInvitation()
    const inv = invitations.create({ surveyKey: 'другой-опрос', versionNo: 2, context: snapshot }, now())
    const nonce = await issueNonce(api)
    const r = await api.submit({ ip: 'a', body: { ...validPayload(nonce), invitation: inv.token } })
    expect(r.status).toBe(409)
  })

  it('гонка: два параллельных submit с одним приглашением → ровно один 200 и один 409', async () => {
    const { api, invitations, now } = await withInvitation()
    const inv = invitations.create({ surveyKey: SURVEY_KEY, versionNo: 2, context: snapshot }, now())
    const n1 = await issueNonce(api)
    const n2 = await issueNonce(api)
    const [a, b] = await Promise.all([
      api.submit({ ip: 'a', body: { ...validPayload(n1), invitation: inv.token } }),
      api.submit({ ip: 'a', body: { ...validPayload(n2), invitation: inv.token } })
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
  })
})

describe('GET /api/health (#5)', () => {
  it('живая БД → 200 { ok, ts }', async () => {
    const { api, now } = await freshApi()
    const r = await api.health()
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, ts: now().toISOString() })
  })

  it('недоступная БД → 503 без деталей; ошибка уходит в logger', async () => {
    const seen: string[] = []
    const store = new (class extends MemoryStore {
      override async ping(): Promise<never> {
        throw new Error('db down: секрет коннекта')
      }
    })()
    const logger = { ...nullLogger, error: (msg: string) => void seen.push(msg) }
    const r = await createApi({ store, logger }).health()
    expect(r.status).toBe(503)
    expect(r.body['ok']).toBe(false)
    expect(typeof r.body['ts']).toBe('string')
    expect(JSON.stringify(r.body)).not.toMatch(/секрет/)
    expect(seen).toContain('health_ping_failed')
  })

  it('дефолтный onError пишет диагностику в logger при сбое submit (#5)', async () => {
    const seen: string[] = []
    const logger = { ...nullLogger, error: (msg: string) => void seen.push(msg) }
    // store с падающим getVersion инжектируется в createApi (buildDemo идёт на
    // отдельном дефолтном сторе внутри freshApi — как в тестах сбоя выше).
    const { api } = await freshApi({
      store: new (class extends MemoryStore {
        override async getVersion(): Promise<never> {
          throw new Error('boom')
        }
      })(),
      logger
    })
    const nonce = await issueNonce(api)
    expect((await api.submit({ ip: 'a', body: validPayload(nonce) })).status).toBe(500)
    expect(seen).toContain('api_error')
  })

  it('кэшируется в пределах TTL — не долбит БД (#5)', async () => {
    let pings = 0
    const store = new (class extends MemoryStore {
      override async ping(): Promise<void> {
        pings++
      }
    })()
    const c = clock()
    const api = createApi({ store, now: c.now, healthCacheMs: 1000 })
    await api.health()
    await api.health()
    expect(pings).toBe(1) // второй вызов — из кэша
    c.advance(1001)
    await api.health()
    expect(pings).toBe(2) // кэш истёк → новый ping
  })
})

describe('анти-абьюз: примитивы', () => {
  it('MemoryNonceStore: prune освобождает место под maxPending', () => {
    const c = clock()
    const s = new MemoryNonceStore({ ttlMs: 100, maxPending: 1, idGen: () => `n${c.now().getTime()}` })
    expect(s.issue(c.now())).toBeTruthy()
    expect(s.issue(c.now())).toBeNull() // переполнен
    c.advance(101) // первый протух → prune при следующем issue
    expect(s.issue(c.now())).toBeTruthy()
  })

  it('MemoryNonceStore: replay различим, пока не истёк TTL использованного', () => {
    const c = clock()
    const s = new MemoryNonceStore({ ttlMs: 100 })
    const n = s.issue(c.now())!
    expect(s.consume(n, c.now())).toBe('ok')
    expect(s.consume(n, c.now())).toBe('replay')
    c.advance(101)
    expect(s.consume(n, c.now())).toBe('unknown') // после TTL запись о использовании вычищена
  })

  it('SlidingWindowLimiter: окно скользит', () => {
    const c = clock()
    const l = new SlidingWindowLimiter({ limit: 2, windowMs: 1000 })
    expect(l.allow('k', c.now())).toBe(true)
    expect(l.allow('k', c.now())).toBe(true)
    expect(l.allow('k', c.now())).toBe(false)
    c.advance(1001) // старые события выпали из окна
    expect(l.allow('k', c.now())).toBe(true)
  })

  it('SlidingWindowLimiter: maxKeys — потолок памяти; sweep освобождает протухшие ключи', () => {
    const c = clock()
    const l = new SlidingWindowLimiter({ limit: 5, windowMs: 1000, maxKeys: 1 })
    expect(l.allow('ip-1', c.now())).toBe(true)
    expect(l.allow('ip-2', c.now())).toBe(false) // новый ключ при заполненном Map → fail-closed
    expect(l.allow('ip-1', c.now())).toBe(true) // существующий ключ работает
    c.advance(1001) // окно ip-1 протухло → sweep при переполнении освободит место
    expect(l.allow('ip-2', c.now())).toBe(true)
  })
})
