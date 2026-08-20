import { describe, expect, it, vi } from 'vitest'
import { createApi, SUPPORTED_SCHEMA_VERSION, type Api } from '../src/api/handlers'
import { nullLogger } from '../src/obs/logger'
import { MemoryNonceStore } from '../src/api/nonce'
import { MemoryInvitationStore, type InvitationStore } from '../src/api/invitation'
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
    expect(r.body['error']).toBe('Не удалось отправить ответ.')
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
    // Пользователю — понятная подсказка «обновите страницу» (номер версии — техношум, не показываем).
    expect(String(r.body['error'])).toMatch(/устарела.*Обновите/)
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
    // кривое тело: если бы honeypot сработал — был бы generic «Не удалось отправить ответ.»
    const r = await api.submit({ ip: 'a', body: { hp: '   ' } })
    expect(r.status).toBe(400)
    expect(r.body['error']).toBe('Ответ не отправлен: проверьте заполнение и попробуйте снова.')
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
    const inv = await invitations.create({ surveyKey: SURVEY_KEY, versionNo: 2, context: snapshot }, now())
    const nonce = await issueNonce(api)
    const r = await api.submit({ ip: 'a', body: { ...validPayload(nonce), invitation: inv.token } })
    expect(r.status).toBe(200)
    const saved = (await store.listResponses()).at(-1)!
    expect(saved.context).toEqual(snapshot)
    // токен приглашения проброшен в запись — durable-якорь идемпотентности стора (#3/#4)
    expect(saved.invitationToken).toBe(inv.token)
    // ⚠️ И сама ссылка ПОГАШЕНА. Без этой строки удаление всего блока гашения переживало новые
    // тесты: последний шаг переставленного порядка держался бы на побочной проверке предпросмотра
    // из другого describe. А на `used_at` стоят и приватность снимка, и чистка по сроку.
    expect(await invitations.peek(inv.token, now()), 'ссылка осталась годной после отправки')
      .toBeUndefined()
  })

  it('submit без приглашения → запись без invitationToken (дедуп не нужен)', async () => {
    const { api, store } = await freshApi()
    const nonce = await issueNonce(api)
    expect((await api.submit({ ip: 'a', body: validPayload(nonce) })).status).toBe(200)
    expect((await store.listResponses()).at(-1)!.invitationToken).toBeUndefined()
  })

  it('повторное использование приглашения → 409 (идемпотентность #4)', async () => {
    const { api, invitations, now } = await withInvitation()
    const inv = await invitations.create({ surveyKey: SURVEY_KEY, versionNo: 2, context: snapshot }, now())
    const n1 = await issueNonce(api)
    expect((await api.submit({ ip: 'a', body: { ...validPayload(n1), invitation: inv.token } })).status).toBe(200)
    const n2 = await issueNonce(api)
    expect((await api.submit({ ip: 'a', body: { ...validPayload(n2), invitation: inv.token } })).status).toBe(409)
  })

  it('ОТКАЗ ЗАПИСИ оставляет ссылку живой — человек отправляет ещё раз и проходит', async () => {
    // ⚠️ Суть #170. Раньше токен гасился ДО записи: сбой на записи убивал ссылку навсегда, а
    // человек читал «вы уже прошли опрос» по анкете, которой нет. Переиздать её мог только менеджер.
    const invitations = new MemoryInvitationStore({ idGen: () => 'inv-tok-1' })
    const store = await buildDemo(new MemoryStore())
    // Подменяем МЕТОД на настоящем сторе (`vi.spyOn`), а не копируем объект: копия через
    // `Object.create`/`Object.assign` работала бы лишь пока состояние лежит в TS-`private` полях, а
    // перевод любого на `#private` превратил бы её в рантайм-ошибку — в тесте, который и есть
    // доказательство #170.
    let failWrite = true
    const real = store.addResponse.bind(store)
    const spy = vi.spyOn(store, 'addResponse').mockImplementation((r) =>
      failWrite ? Promise.reject(new Error('БД недоступна')) : real(r)
    )
    const c = clock()
    const api = createApi({ store, invitations, now: c.now, logger: nullLogger })
    const inv = await invitations.create({ surveyKey: SURVEY_KEY, versionNo: 2, context: snapshot }, c.now())

    expect((await api.submit({ ip: 'a', body: { ...validPayload(await issueNonce(api)), invitation: inv.token } })).status)
      .toBe(500)
    expect(await invitations.peek(inv.token, c.now()), 'ссылка сгорела на неудавшейся записи').toBeDefined()
    // Именно это отличает «отказ записи» от «записали и соврали». Считаем по НАШЕМУ токену: стор
    // засеян демо-данными, поэтому пустым он не бывает.
    expect(
      (await store.listResponses()).filter((r) => r.invitationToken === inv.token),
      'на отказе записи ответ всё же записался'
    ).toHaveLength(0)

    failWrite = false
    expect((await api.submit({ ip: 'a', body: { ...validPayload(await issueNonce(api)), invitation: inv.token } })).status)
      .toBe(200)
    expect((await store.listResponses()).at(-1)!.context).toEqual(snapshot)
    spy.mockRestore()
  })

  it('ОТКАЗ ГАШЕНИЯ после записи не теряет ответ, а повтор самозаживает в 409', async () => {
    // Отказ на последнем шаге: ответ уже записан, поэтому 200 честен. Повторная отправка упирается
    // в дедуп по токену и получает «опрос пройден» — что и есть правда, хотя ссылка ещё жива.
    const inner = new MemoryInvitationStore({ idGen: () => 'inv-tok-1' })
    // Отказ ОДНОРАЗОВЫЙ — блип БД, а не вечная поломка: только так видно, что состояние «ответ есть,
    // ссылка жива» самозаживает, а не остаётся терминальным.
    let burnFails = true
    const invitations: InvitationStore = {
      create: (...a) => inner.create(...a),
      peek: (...a) => inner.peek(...a),
      consume: (...a) => {
        if (burnFails) { burnFails = false; return Promise.reject(new Error('БД недоступна')) }
        return inner.consume(...a)
      }
    }
    const store = await buildDemo(new MemoryStore())
    const c = clock()
    const api = createApi({ store, invitations, now: c.now, logger: nullLogger })
    const inv = await inner.create({ surveyKey: SURVEY_KEY, versionNo: 2, context: snapshot }, c.now())

    expect((await api.submit({ ip: 'a', body: { ...validPayload(await issueNonce(api)), invitation: inv.token } })).status)
      .toBe(200)
    expect((await store.listResponses()).at(-1)!.invitationToken).toBe(inv.token)
    const again = await api.submit({ ip: 'a', body: { ...validPayload(await issueNonce(api)), invitation: inv.token } })
    expect(again.status, 'повтор по живой ссылке с уже записанным ответом должен дать 409').toBe(409)
    // Текст — весь смысл #170: человеку говорят правду. Без этой проверки подмена `replay` на
    // `mismatch` («Ссылка не подходит к этому опросу») проходила молча.
    expect((again.body as { error: string }).error).toContain('опрос пройден')
    expect((await store.listResponses()).filter((r) => r.invitationToken === inv.token), 'ответ задвоился')
      .toHaveLength(1)
    // И ссылка догашена ЭТИМ повтором: состояние «ответ есть, ссылка жива» самозаживает не только
    // по статусу ответа, но и по самой ссылке — иначе предпросмотр бессрочно звал бы заполнять заново.
    expect(await inner.peek(inv.token, c.now()), 'ссылка так и осталась годной').toBeUndefined()
  })

  it('НЕуспешное гашение видно в логе (иначе расхождение тонет молча)', async () => {
    // ⚠️ Мутация «удалить `logger.warn` целиком» переживала весь набор: единственный след состояния
    // «ответ записан, ссылка не погашена» был бы стёрт, и найти такие ссылки стало бы нечем.
    // Берём НЕ-бросающий неуспех (`unknown` — ссылку убрал сосед/чистка): бросающий путь покрыт выше.
    const inner = new MemoryInvitationStore({ idGen: () => 'inv-tok-1' })
    const invitations: InvitationStore = {
      create: (...a) => inner.create(...a),
      peek: (...a) => inner.peek(...a),
      consume: () => Promise.resolve({ status: 'unknown' })
    }
    const seen: Array<[string, Record<string, unknown>]> = []
    const store = await buildDemo(new MemoryStore())
    const c = clock()
    const api = createApi({
      store,
      invitations,
      now: c.now,
      logger: { ...nullLogger, warn: (msg, fields) => seen.push([msg, fields ?? {}]) }
    })
    const inv = await inner.create({ surveyKey: SURVEY_KEY, versionNo: 2, context: snapshot }, c.now())
    expect((await api.submit({ ip: 'a', body: { ...validPayload(await issueNonce(api)), invitation: inv.token } })).status)
      .toBe(200)
    const line = seen.find(([m]) => m === 'invitation_burn_failed')
    expect(line, 'расхождение «ответ есть, ссылка жива» нигде не отмечено').toBeDefined()
    expect(line![1]).toMatchObject({ status: 'unknown', surveyKey: SURVEY_KEY, versionNo: 2 })
    // Токен — секрет-ссылка: в лог он не попадает ни под каким видом.
    expect(JSON.stringify(line![1])).not.toContain(inv.token)
  })

  it('`replay` при гашении расхождением НЕ считается (ссылку погасила прошлая попытка)', async () => {
    const inner = new MemoryInvitationStore({ idGen: () => 'inv-tok-1' })
    const invitations: InvitationStore = {
      create: (...a) => inner.create(...a),
      peek: (...a) => inner.peek(...a),
      consume: () => Promise.resolve({ status: 'replay' })
    }
    const seen: string[] = []
    const c = clock()
    const api = createApi({
      store: await buildDemo(new MemoryStore()),
      invitations,
      now: c.now,
      logger: { ...nullLogger, warn: (msg) => seen.push(msg) }
    })
    const inv = await inner.create({ surveyKey: SURVEY_KEY, versionNo: 2, context: snapshot }, c.now())
    await api.submit({ ip: 'a', body: { ...validPayload(await issueNonce(api)), invitation: inv.token } })
    expect(seen, 'штатное «уже погашено» записано как расхождение — лог зашумлён').not.toContain('invitation_burn_failed')
  })

  it('ОТКАЗ `peek` → 500, ответ не записан, ссылка цела', async () => {
    // Третья из трёх точек отказа, перечисленных в JSDoc `submit`. Ветка держится на общем `catch`,
    // и любая правка порядка (например, ранний расчёт контекста) сломала бы её молча.
    const inner = new MemoryInvitationStore({ idGen: () => 'inv-tok-1' })
    let peekFails = true
    const invitations: InvitationStore = {
      create: (...a) => inner.create(...a),
      peek: (...a) => (peekFails ? Promise.reject(new Error('БД недоступна')) : inner.peek(...a)),
      consume: (...a) => inner.consume(...a)
    }
    const store = await buildDemo(new MemoryStore())
    const c = clock()
    const api = createApi({ store, invitations, now: c.now, logger: nullLogger })
    const inv = await inner.create({ surveyKey: SURVEY_KEY, versionNo: 2, context: snapshot }, c.now())
    expect((await api.submit({ ip: 'a', body: { ...validPayload(await issueNonce(api)), invitation: inv.token } })).status)
      .toBe(500)
    expect((await store.listResponses()).filter((r) => r.invitationToken === inv.token)).toHaveLength(0)
    peekFails = false
    expect(await inner.peek(inv.token, c.now()), 'ссылка сгорела на отказе предпросмотра').toBeDefined()
    expect((await api.submit({ ip: 'a', body: { ...validPayload(await issueNonce(api)), invitation: inv.token } })).status)
      .toBe(200)
  })

  it('прошедший опрос слышит «спасибо», а не «попросите новую ссылку»', async () => {
    // Тексты разные, и разница видна человеку: 409 replay говорит «опрос пройден», 403 dead —
    // «попросите новую ссылку у менеджера». Второе прошедшему опрос — неправда.
    const { api, invitations, now } = await withInvitation()
    const inv = await invitations.create({ surveyKey: SURVEY_KEY, versionNo: 2, context: snapshot }, now())
    await api.submit({ ip: 'a', body: { ...validPayload(await issueNonce(api)), invitation: inv.token } })
    const again = await api.submit({ ip: 'a', body: { ...validPayload(await issueNonce(api)), invitation: inv.token } })
    expect(again.status).toBe(409)
    expect((again.body as { error: string }).error).toContain('опрос пройден')
  })

  it('после записи зовётся `onAnswered` со снимком CRM (закрытие дела, #177)', async () => {
    const seen: Array<{ surveyKey: string; dealId?: number; versionNo: number }> = []
    const invitations = new MemoryInvitationStore({ idGen: () => 'inv-tok-1' })
    const base = await freshApi({
      invitations,
      onAnswered: (i) => { seen.push({ surveyKey: i.surveyKey, dealId: i.context.dealId, versionNo: i.versionNo }); return Promise.resolve() }
    })
    const inv = await invitations.create({ surveyKey: SURVEY_KEY, versionNo: 2, context: snapshot }, base.now())
    expect((await base.api.submit({
      ip: 'a', body: { ...validPayload(await issueNonce(base.api)), invitation: inv.token }
    })).status).toBe(200)
    expect(seen).toEqual([{ surveyKey: SURVEY_KEY, dealId: snapshot.dealId, versionNo: 2 }])
  })

  it('ОТКАЗ `onAnswered` не портит ответ клиенту (200) и не теряет диагностику', async () => {
    // ⚠️ Ответ клиента дороже отметки в таймлайне: заставить человека заполнять анкету заново
    // из-за недоступности портала — худшее, что тут можно сделать. Но и молчать нельзя: тогда
    // «дело закрыто» было бы неотличимо от «не смогли».
    const errs: unknown[] = []
    const invitations = new MemoryInvitationStore({ idGen: () => 'inv-tok-1' })
    const base = await freshApi({
      invitations,
      onAnswered: () => Promise.reject(new Error('портал недоступен')),
      onError: (e) => errs.push(e)
    })
    const inv = await invitations.create({ surveyKey: SURVEY_KEY, versionNo: 2, context: snapshot }, base.now())
    const r = await base.api.submit({
      ip: 'a', body: { ...validPayload(await issueNonce(base.api)), invitation: inv.token }
    })
    expect(r.status).toBe(200)
    expect((await base.store.listResponses()).at(-1)!.context).toEqual(snapshot)
    expect((errs[0] as Error).message).toBe('портал недоступен')
  })

  it('повтор (409) `onAnswered` НЕ зовёт — закрывать нечего, ответ уже был', async () => {
    const seen: string[] = []
    const invitations = new MemoryInvitationStore({ idGen: () => 'inv-tok-1' })
    const base = await freshApi({ invitations, onAnswered: () => { seen.push('x'); return Promise.resolve() } })
    const inv = await invitations.create({ surveyKey: SURVEY_KEY, versionNo: 2, context: snapshot }, base.now())
    await base.api.submit({ ip: 'a', body: { ...validPayload(await issueNonce(base.api)), invitation: inv.token } })
    await base.api.submit({ ip: 'a', body: { ...validPayload(await issueNonce(base.api)), invitation: inv.token } })
    expect(seen).toHaveLength(1)
  })

  it('неизвестный токен → 403', async () => {
    const { api } = await withInvitation()
    const nonce = await issueNonce(api)
    const r = await api.submit({ ip: 'a', body: { ...validPayload(nonce), invitation: 'нет-такого' } })
    expect(r.status).toBe(403)
  })

  it('ПРОТУХШИЙ (и не использованный) токен → 403 «попросите новую»', async () => {
    // Раньше эта ветка называлась «протухший», а подавала несуществующий токен — часы не двигались.
    // Диагностика #170 различает `unknown` и `replay` именно по сроку, и обе ветки должны считаться.
    const invitations = new MemoryInvitationStore({ idGen: () => 'inv-tok-1' })
    const base = await freshApi({ invitations })
    const inv = await invitations.create(
      { surveyKey: SURVEY_KEY, versionNo: 2, context: snapshot, ttlMs: 60_000 }, base.now()
    )
    base.advance(120_000)
    const r = await base.api.submit({
      ip: 'a', body: { ...validPayload(await issueNonce(base.api)), invitation: inv.token }
    })
    expect(r.status).toBe(403)
    expect((r.body as { error: string }).error).toContain('новую ссылку')
  })

  it('ИСПОЛЬЗОВАННЫЙ, а потом протухший → 409 «спасибо», а не «срок истёк»', async () => {
    // Человек прошёл опрос месяц назад и открыл ту же ссылку снова. Ему полагается «спасибо», а не
    // «попросите новую» — иначе менеджер выпишет вторую ссылку и по сделке появится второй ответ.
    const invitations = new MemoryInvitationStore({ idGen: () => 'inv-tok-1' })
    const base = await freshApi({ invitations })
    const inv = await invitations.create(
      { surveyKey: SURVEY_KEY, versionNo: 2, context: snapshot, ttlMs: 60_000 }, base.now()
    )
    expect((await base.api.submit({
      ip: 'a', body: { ...validPayload(await issueNonce(base.api)), invitation: inv.token }
    })).status).toBe(200)
    base.advance(120_000)
    const again = await base.api.submit({
      ip: 'a', body: { ...validPayload(await issueNonce(base.api)), invitation: inv.token }
    })
    expect(again.status).toBe(409)
    expect((again.body as { error: string }).error).toContain('опрос пройден')
  })

  it('приглашение от другого опроса/версии → 409 (несоответствие пина)', async () => {
    const { api, invitations, now } = await withInvitation()
    // версия приглашения 1, а payload идёт на версию 2
    const inv = await invitations.create({ surveyKey: SURVEY_KEY, versionNo: 1, context: snapshot }, now())
    const nonce = await issueNonce(api)
    const r = await api.submit({ ip: 'a', body: { ...validPayload(nonce), invitation: inv.token } })
    expect(r.status).toBe(409)
  })

  it('422 по ответам НЕ сжигает приглашение — можно дослать корректные', async () => {
    const { api, store, invitations, now } = await withInvitation()
    const inv = await invitations.create({ surveyKey: SURVEY_KEY, versionNo: 2, context: snapshot }, now())
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
    const inv = await invitations.create({ surveyKey: 'другой-опрос', versionNo: 2, context: snapshot }, now())
    const nonce = await issueNonce(api)
    const r = await api.submit({ ip: 'a', body: { ...validPayload(nonce), invitation: inv.token } })
    expect(r.status).toBe(409)
  })

  it('гонка: два параллельных submit с одним приглашением → ровно один 200 и один 409', async () => {
    // ⚠️ После #170 одноразовость держит НЕ `consume`, а дедуп по токену в сторе ответов: оба
    // запроса проходят `peek`, оба входят в запись, и разводит их `stored`. Тест остался тем же
    // снаружи, но проверяет теперь другой барьер — не перепутайте при следующей правке.
    const { api, invitations, now } = await withInvitation()
    const inv = await invitations.create({ surveyKey: SURVEY_KEY, versionNo: 2, context: snapshot }, now())
    const n1 = await issueNonce(api)
    const n2 = await issueNonce(api)
    const [a, b] = await Promise.all([
      api.submit({ ip: 'a', body: { ...validPayload(n1), invitation: inv.token } }),
      api.submit({ ip: 'a', body: { ...validPayload(n2), invitation: inv.token } })
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
  })

  /**
   * Шов, ради которого порт и сделан асинхронным.
   *
   * ⚠️ Тест на гонку выше через него НЕ проходит: `MemoryInvitationStore` разрешается синхронно, то
   * есть точки прерывания внутри `consume` не возникает вовсе, и «работает с async-стором» он не
   * доказывает. Реализация на БД ждёт по-настоящему — между входом в `consume` и его результатом
   * успевает выполниться чужой код. Здесь это воспроизводится стором, который **намеренно
   * откладывает** каждый ответ.
   *
   * Он же ловит пропущенный `await`: `typecheck` его не видит там, где результат не разыменовывают
   * (`void store.create(...)`), а без ожидания `inv.status === 'replay'` станет ложным на Promise —
   * и одноразовое приглашение перестанет быть одноразовым.
   */
  it('стор, который РЕАЛЬНО ждёт, не ломает ни расход приглашения, ни его одноразовость', async () => {
    const yieldTurn = () => new Promise<void>((r) => setImmediate(r))
    const inner = new MemoryInvitationStore({ idGen: () => 'inv-slow-1' })
    let deferrals = 0
    const slow: InvitationStore = {
      async create(input, at) { deferrals++; await yieldTurn(); return inner.create(input, at) },
      async peek(token, at) { deferrals++; await yieldTurn(); return inner.peek(token, at) },
      async consume(token, pin, at) { deferrals++; await yieldTurn(); return inner.consume(token, pin, at) }
    }
    const base = await freshApi({ invitations: slow })
    const inv = await slow.create({ surveyKey: SURVEY_KEY, versionNo: 2, context: snapshot }, base.now())

    const [n1, n2] = [await issueNonce(base.api), await issueNonce(base.api)]
    const [a, b] = await Promise.all([
      base.api.submit({ ip: 'a', body: { ...validPayload(n1), invitation: inv.token } }),
      base.api.submit({ ip: 'a', body: { ...validPayload(n2), invitation: inv.token } })
    ])
    expect([a.status, b.status].sort(), 'ссылка сработала дважды').toEqual([200, 409])
    // снимок из приглашения доехал до записи — значит ждали результат, а не Promise
    expect((await base.store.listResponses()).at(-1)!.context).toEqual(snapshot)
    expect(deferrals, 'фейк-стор ни разу не вызван — тест ничего не проверяет').toBeGreaterThan(2)
  })
})

describe('GET /api/survey/:key/invitation — годность ссылки ДО заполнения', () => {
  const snapshot = { dealId: 5994, companyId: 3986, dealStageId: 'WON' }

  async function withInvitation(): Promise<{ api: Api, invitations: MemoryInvitationStore, now: () => Date }> {
    const invitations = new MemoryInvitationStore({ idGen: () => 'inv-check-1' })
    const base = await freshApi({ invitations })
    return { api: base.api, invitations, now: base.now }
  }

  it('живая ссылка → 200 и НИ ОДНОГО поля снимка наружу', async () => {
    // Главное свойство роута: по нему ходит неаутентифицированный респондент, а `peek` отдаёт
    // приглашение вместе с CRM-снимком (`responsibleName` помечен PII). Наружу — только годность.
    const { api, invitations, now } = await withInvitation()
    const inv = await invitations.create({ surveyKey: SURVEY_KEY, versionNo: 2, context: snapshot }, now())
    const r = await api.invitationCheck({ ip: 'a', surveyKey: SURVEY_KEY, token: inv.token })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    const dump = JSON.stringify(r.body)
    for (const leak of ['5994', '3986', 'WON', 'inv-check-1']) {
      expect(dump, `${leak} уехал респонденту`).not.toContain(leak)
    }
  })

  it('проверка НЕ расходует приглашение — иначе она же его и убивала бы', async () => {
    const { api, invitations, now } = await withInvitation()
    const inv = await invitations.create({ surveyKey: SURVEY_KEY, versionNo: 2, context: snapshot }, now())
    expect((await api.invitationCheck({ ip: 'a', surveyKey: SURVEY_KEY, token: inv.token })).status).toBe(200)
    expect((await api.invitationCheck({ ip: 'a', surveyKey: SURVEY_KEY, token: inv.token })).status).toBe(200)
    // И после двух проверок ссылка по-прежнему рабочая для отправки.
    const nonce = await issueNonce(api)
    const sent = await api.submit({ ip: 'a', body: { ...validPayload(nonce), invitation: inv.token } })
    expect(sent.status, 'проверка сожгла приглашение').toBe(200)
  })

  it('использованная ссылка → 403 с текстом про оба случая сразу', async () => {
    // `peek` не различает «использована» и «протухла» — оба дают `undefined`. Значит выбирать один
    // текст наугад нельзя: он был бы неправдой в половине случаев.
    const { api, invitations, now } = await withInvitation()
    const inv = await invitations.create({ surveyKey: SURVEY_KEY, versionNo: 2, context: snapshot }, now())
    const nonce = await issueNonce(api)
    expect((await api.submit({ ip: 'a', body: { ...validPayload(nonce), invitation: inv.token } })).status).toBe(200)
    const r = await api.invitationCheck({ ip: 'a', surveyKey: SURVEY_KEY, token: inv.token })
    expect(r.status).toBe(403)
    expect(String(r.body.error)).toContain('уже пройден')
  })

  it('неизвестный токен → 403', async () => {
    const { api } = await withInvitation()
    expect((await api.invitationCheck({ ip: 'a', surveyKey: SURVEY_KEY, token: 'нет-такого' })).status).toBe(403)
  })

  it('ссылка от другого опроса неотличима от мёртвой — иначе это бит существования токена', async () => {
    // ⚠️ Ответ «ссылка не подходит к ЭТОМУ опросу» сообщает, что токен существует. Сказать это
    // человеку по нашей ссылке невозможно: `deal-invite` собирает ключ и токен из одной записи
    // через `surveyPath`, и разойтись им негде. Значит текст адресован никому, а бит отдаёт всем.
    const { api, invitations, now } = await withInvitation()
    const inv = await invitations.create({ surveyKey: 'другой-опрос', versionNo: 2, context: snapshot }, now())
    const alive = await api.invitationCheck({ ip: 'a', surveyKey: SURVEY_KEY, token: inv.token })
    const dead = await api.invitationCheck({ ip: 'a', surveyKey: SURVEY_KEY, token: 'нет-такого' })
    expect(alive.status).toBe(403)
    expect(alive, 'существующий и несуществующий токены различимы по ответу').toEqual(dead)
    // При этом сам токен НЕ сожжён: слияние текстов ничего не расходует.
    expect(await invitations.peek(inv.token, now()), 'проверка убила чужое приглашение').toBeDefined()
  })

  it('токен длиннее 200 символов → 400 «ссылка повреждена», и стор не тревожим', async () => {
    // Форма токена — одна на оба входа. Пока границы было две (у `submit` — есть, у проверки —
    // нет), один и тот же вход получал два разных диагноза, а токен любого размера доезжал до
    // стора: сегодня это Map, завтра — параметр SQL-запроса (#4).
    const backing = new MemoryInvitationStore()
    let peeked = 0
    const spy: InvitationStore = {
      create: (i, n) => backing.create(i, n),
      peek: (t, n) => { peeked++; return backing.peek(t, n) },
      consume: (t, p, n) => backing.consume(t, p, n)
    }
    const { api, now } = await freshApi({ invitations: spy })
    const r = await api.invitationCheck({ ip: 'a', surveyKey: SURVEY_KEY, token: 'x'.repeat(201) })
    expect(r.status).toBe(400)
    expect(String(r.body.error)).toContain('повреждена')
    expect(peeked, 'негодный по форме токен доехал до стора').toBe(0)
    // Ровно 200 символов — ещё годная форма (граница та же, что у submit): дошло до стора.
    await spy.create({ token: 'y'.repeat(200), surveyKey: SURVEY_KEY, versionNo: 2, context: snapshot }, now())
    expect((await api.invitationCheck({ ip: 'a', surveyKey: SURVEY_KEY, token: 'y'.repeat(200) })).status).toBe(200)
    expect(peeked).toBe(1)
  })

  it('опрос переиздан после выписки ссылки → 409 ЗДЕСЬ, а не после заполнения', async () => {
    // Приглашение пинится на версию, и `submit` отвергает чужую. Без этой ветки человек прошёл бы
    // весь опрос и получил отказ на «Отправить» — ровно то, ради чего роут и заведён.
    const { api, invitations, now } = await withInvitation()
    const inv = await invitations.create({ surveyKey: SURVEY_KEY, versionNo: 1, context: snapshot }, now())
    const r = await api.invitationCheck({ ip: 'a', surveyKey: SURVEY_KEY, token: inv.token })
    expect(r.status).toBe(409)
    expect(String(r.body.error)).toContain('обновился')
  })

  it('кривой адрес опроса → 400 (до похода в стор)', async () => {
    // Три ветки — 400/404/500 — были единственными непокрытыми в файле: у соседних `survey`/`submit`
    // аналогичные закрыты, и новый хендлер отставал от стандарта собственного файла.
    // Пустой ключ — реальный вход: роут берёт `getRouterParam(event, 'key') ?? ''`.
    const { api } = await withInvitation()
    expect((await api.invitationCheck({ ip: 'a', surveyKey: '', token: 'x' })).status).toBe(400)
    expect((await api.invitationCheck({ ip: 'a', surveyKey: 'k'.repeat(201), token: 'x' })).status).toBe(400)
  })

  it('приглашение живо, а опубликованной версии опроса нет → 404', async () => {
    const { api, invitations, now } = await withInvitation()
    const inv = await invitations.create({ surveyKey: 'ghost', versionNo: 1, context: snapshot }, now())
    const r = await api.invitationCheck({ ip: 'a', surveyKey: 'ghost', token: inv.token })
    expect(r.status).toBe(404)
    expect(String(r.body.error)).toContain('Опрос не найден')
  })

  it('стор упал → 500 и НИ СЛОВА о причине наружу', async () => {
    // Текст ошибки стора может нести DSN и снимок сделки. Наружу уходит только наш литерал.
    const boom = new Error('DSN=postgres://user:PASSWORD@db/polls, dealId=5994')
    const failing: InvitationStore = {
      create: () => Promise.reject(boom),
      peek: () => Promise.reject(boom),
      consume: () => Promise.reject(boom)
    }
    const { api } = await freshApi({ invitations: failing, onError: () => {} })
    const r = await api.invitationCheck({ ip: 'a', surveyKey: SURVEY_KEY, token: 'x' })
    expect(r.status).toBe(500)
    const dump = JSON.stringify(r.body)
    for (const leak of ['PASSWORD', 'postgres://', '5994']) {
      expect(dump, `${leak} уехал респонденту`).not.toContain(leak)
    }
  })

  it('свой бюджет лимитера: перебор токенов не съедает лимит чтения опроса', async () => {
    const { api, invitations, now } = await withInvitation()
    const inv = await invitations.create({ surveyKey: SURVEY_KEY, versionNo: 2, context: snapshot }, now())
    for (let i = 0; i < 12; i++) await api.invitationCheck({ ip: 'flood', surveyKey: SURVEY_KEY, token: 'x' })
    expect((await api.invitationCheck({ ip: 'flood', surveyKey: SURVEY_KEY, token: inv.token })).status).toBe(429)
    // Страница того же респондента при этом открывается: бюджеты раздельные.
    expect((await api.survey({ ip: 'flood', surveyKey: SURVEY_KEY })).status).toBe(200)
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
