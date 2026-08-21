import { describe, expect, it, vi } from 'vitest'
import { resultViewDecision, MAX_RESPONSE_ID_LEN, type ResultViewDeps } from '../server/utils/result-view'
import type { FrameAuth, VerifiedPortal } from '../src/bitrix24/frame'
import type { CompiledVersion, Question, ResponseRecord } from '../src/domain/schema'

/**
 * Решение страницы результата (#18) — ИСПОЛНЯЕМО.
 *
 * ⚠️ Пока это жило телом роута, проверить можно было только грепом по исходнику, и ревью показало
 * цену: мутация «в `catch` вокруг подтверждения портала взять портал прямо из тела запроса»
 * проходила ВЕСЬ набор зелёной. То есть анонимный POST с выдуманным `member_id` читал бы свободный
 * текст клиентов любого портала, а `pnpm check` этого не видел. Исходов здесь восемь, семь из них —
 * отказы, и каждый полностью выключает страницу.
 */
const FRAME: FrameAuth = {
  DOMAIN: 'acme.bitrix24.ru',
  AUTH_ID: 'user-token',
  member_id: 'member-id-fake-0000000000000000'
} as FrameAuth

const PORTAL: VerifiedPortal = { portalId: 'member-id-fake-0000000000000000', domain: 'acme.bitrix24.ru', admin: false }

const q = (over: Partial<Question> & { key: string; text: string }): Question => ({
  type: 'single', metric: 'scale', required: true, options: [], ...over
})

const version = (over: Partial<CompiledVersion> = {}): CompiledVersion => ({
  surveyKey: 'csat_postdeal',
  title: 'Оценка после сделки',
  lang: 'ru',
  versionNo: 2,
  questions: [q({ key: 'q_why', text: 'Почему?', type: 'text', metric: 'text' })],
  compiledAt: '2026-07-24T10:00:00.000Z',
  ...over
})

const record = (over: Partial<ResponseRecord> = {}): ResponseRecord => ({
  id: 'r-42',
  surveyKey: 'csat_postdeal',
  versionNo: 2,
  submittedAt: '2026-07-24T10:05:00.000Z',
  context: { dealId: 759 },
  answers: [{ questionKey: 'q_why', metric: 'text', valueChoice: [], valueNumber: null, valueText: 'быстро' }],
  ...over
})

function deps(over: Partial<ResultViewDeps> = {}) {
  const logs: Array<[string, string, Record<string, unknown>]> = []
  const d: ResultViewDeps = {
    verify: async () => PORTAL,
    tenant: async () => ({
      store: { getResponse: async () => record(), getVersion: async () => version() }
    }),
    assertDealAccess: async () => undefined,
    log: { info: (e, f) => logs.push(['info', e, f]), warn: (e, f) => logs.push(['warn', e, f]) },
    ...over
  }
  return { ...d, logs }
}

/** Годный вход — чтобы каждый тест отказа отличался ровно одной подменённой зависимостью. */
const ask = (d: ResultViewDeps) => resultViewDecision({ frame: FRAME, responseId: 'r-42' }, d)

describe('страница результата: что отдаём (#18)', () => {
  it('всё сошлось → 200 с ВИДОМ, а не с сырой записью', async () => {
    const d = deps()
    const out = await ask(d)
    expect(out.status).toBe(200)
    if (out.status !== 200) throw new Error('unreachable')
    expect(out.body.view.lines).toEqual([{ label: 'Почему?', value: 'быстро' }])
    // ⚠️ Сырая запись наружу не уходит: с ней поимённый срез контекста (`responsibleName` не
    // выводим, #31) обошёлся бы одним лишним словом в возврате.
    expect(JSON.stringify(out.body)).not.toContain('answers')
    // След чтения индивидуальных ПДн обязателен — по нему отвечают субъекту данных (#31/#10).
    expect(d.logs.find((l) => l[1] === 'b24_result_view')?.[2])
      .toMatchObject({ portalId: PORTAL.portalId, responseId: 'r-42', dealId: 759 })
  })
})

describe('страница результата: отказы (#18)', () => {
  it('портал НЕ подтверждён → 401, и портал НЕ берётся из тела', async () => {
    // ⚠️ Ровно та мутация, что проходила весь набор: «не подтвердился — возьмём `member_id` из
    // POST». После неё анонимный запрос читал бы чужие данные.
    const tenant = vi.fn(async () => ({
      store: { getResponse: async () => record(), getVersion: async () => version() }
    }))
    const out = await ask(deps({ verify: async () => { throw new Error('домен не в allowlist') }, tenant }))
    expect(out.status).toBe(401)
    expect(tenant, 'к данным пошли, не подтвердив портал').not.toHaveBeenCalled()
  })

  it('приложение удалили между проверкой и чтением → 409 с понятным текстом', async () => {
    const out = await ask(deps({ tenant: async () => undefined }))
    expect(out.status).toBe(409)
    expect(out.body.ok).toBe(false)
  })

  it('нет записи → 404', async () => {
    const out = await ask(deps({
      tenant: async () => ({ store: { getResponse: async () => undefined, getVersion: async () => version() } })
    }))
    expect(out.status).toBe(404)
  })

  it('нет доступа к СДЕЛКЕ → 404 тем же текстом, и это записано в лог', async () => {
    // ⚠️ Фрейм-токен доказывает портал, но не право на сделку. Без этой ветки рядовой менеджер
    // перебором id читал бы свободный текст клиентов по закрытым для него сделкам.
    const d = deps({ assertDealAccess: async () => { throw new Error('нет доступа') } })
    const out = await ask(d)
    expect(out.status).toBe(404)
    expect(d.logs.find((l) => l[1] === 'b24_result_denied')).toBeDefined()
  })

  it('опрос обещал АНОНИМНОСТЬ → 404 тем же текстом', async () => {
    // ⚠️ Дела и кнопки для такого опроса не существует, но ЗАПИСЬ существует: без проверки на чтении
    // перебор выдавал бы связку «этот клиент ↔ эта сделка ↔ этот текст».
    const d = deps({
      tenant: async () => ({
        store: {
          getResponse: async () => record(),
          getVersion: async () => version({ invitationPolicy: { resultToTimeline: false } })
        }
      })
    })
    const out = await ask(d)
    expect(out.status).toBe(404)
    expect(d.logs.find((l) => l[1] === 'b24_result_anonymous')).toBeDefined()
  })

  it('отказы неразличимы между собой: один статус, один текст', async () => {
    // ⚠️ Разница между «нет записи», «чужой портал», «нет доступа» и «анонимный опрос» — это ответ на
    // вопрос «есть ли такой ответ у кого-то ещё», который спрашивающему задавать не положено.
    const noRecord = await ask(deps({
      tenant: async () => ({ store: { getResponse: async () => undefined, getVersion: async () => version() } })
    }))
    const noAccess = await ask(deps({ assertDealAccess: async () => { throw new Error('x') } }))
    const anonymous = await ask(deps({
      tenant: async () => ({
        store: {
          getResponse: async () => record(),
          getVersion: async () => version({ invitationPolicy: { resultToTimeline: false } })
        }
      })
    }))
    expect(noAccess).toEqual(noRecord)
    expect(anonymous).toEqual(noRecord)
  })

  it('запись без СДЕЛКИ → 404: проверять права не на чем', async () => {
    const assertDealAccess = vi.fn(async () => undefined)
    const out = await ask(deps({
      assertDealAccess,
      tenant: async () => ({
        store: { getResponse: async () => record({ context: {} }), getVersion: async () => version() }
      })
    }))
    expect(out.status).toBe(404)
    expect(assertDealAccess, 'права спрашивали без сделки').not.toHaveBeenCalled()
  })

  it('версия не сошлась с записью → 409, а не правдоподобный чужой экран', async () => {
    const d = deps({
      tenant: async () => ({
        store: { getResponse: async () => record(), getVersion: async () => version({ versionNo: 3 }) }
      })
    })
    const out = await ask(d)
    expect(out.status).toBe(409)
    expect(d.logs.find((l) => l[1] === 'b24_result_no_version')?.[0]).toBe('warn')
  })

  it('отказ хранилища → 502, а не утечка внутренностей', async () => {
    const d = deps({ tenant: async () => { throw new Error('пароль=secret в строке подключения') } })
    const out = await ask(d)
    expect(out.status).toBe(502)
    expect(JSON.stringify(out.body), 'внутренности уехали наружу').not.toContain('secret')
    // Редакция секретов живёт в `errInfo`; сырой `.message` в лог не идёт.
    expect(d.logs.find((l) => l[1] === 'b24_result_fail')?.[2]).toHaveProperty('err')
  })

  it('негодный вход → 400 без единого обращения к данным', async () => {
    const tenant = vi.fn(async () => ({
      store: { getResponse: async () => record(), getVersion: async () => version() }
    }))
    const verify = vi.fn(async () => PORTAL)
    // ⚠️ Через `resultViewDecision` напрямую, а не через хелпер: у того `responseId` со значением по
    // умолчанию, и `undefined` подменился бы годным — тест прошёл бы, ничего не проверив.
    for (const bad of [undefined, '', '   ', 42, {}, ['r-42'], 'x'.repeat(MAX_RESPONSE_ID_LEN + 1)]) {
      const out = await resultViewDecision({ frame: FRAME, responseId: bad }, deps({ tenant, verify }))
      expect(out.status, JSON.stringify(bad)).toBe(400)
    }
    // Разбор фрейма не удался — тоже 400, и тоже без обращения к данным.
    expect(await resultViewDecision({ frame: undefined, responseId: 'r-42' }, deps({ tenant, verify })))
      .toMatchObject({ status: 400 })
    expect(tenant).not.toHaveBeenCalled()
    expect(verify, 'исходящий запрос к порталу на заведомо негодном входе').not.toHaveBeenCalled()
  })
})
