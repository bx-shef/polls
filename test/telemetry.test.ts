import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { trace } from '@opentelemetry/api'
import { withDependencySpan, withSpan } from '../src/obs/span'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ERROR_KINDS,
  MAX_ATTRIBUTE_LENGTH,
  PORTAL_HASH_LENGTH,
  TELEMETRY_ATTRIBUTES,
  errorKind,
  pickSafeAttributes,
  portalHash,
  telemetryEnabled
} from '../src/obs/telemetry'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Главное свойство: данные человека прикрепить к спану **нельзя**, а не «мы стараемся не прикреплять».
 * Разница проверяемая — при белом списке новое поле по умолчанию не проходит.
 */
describe('pickSafeAttributes — белый список, а не фильтр', () => {
  it('данные респондента и заказчика не проходят ни под каким именем', () => {
    // Ровно то, что не должно уехать в чужое хранилище: текст ответа, ФИО и телефон из снимка сделки,
    // токен портала, member_id в открытом виде, текст SQL.
    const attempt = pickSafeAttributes({
      answer: 'Всё ужасно, звоните на +375 29 123-45-67',
      'response.text': 'обещали в среду, привезли в пятницу',
      contactName: 'Иванов Иван',
      phone: '+375291234567',
      accessToken: 'secret-token',
      member_id: 'abc123',
      'db.statement': "INSERT INTO response_answer (text) VALUES ('ужасно')",
      'error.message': 'connect ECONNREFUSED postgres://user:pass@host/db'
    })
    expect(attempt).toEqual({})
  })

  it('разрешённые атрибуты проходят', () => {
    expect(pickSafeAttributes({
      'portal.hash': 'deadbeefdeadbeef',
      'b24.method': 'crm.deal.get',
      outcome: 'ok',
      'result.count': 12,
      rate_limited: false
    })).toEqual({
      'portal.hash': 'deadbeefdeadbeef',
      'b24.method': 'crm.deal.get',
      outcome: 'ok',
      'result.count': 12,
      rate_limited: false
    })
  })

  it('только скаляры: объект или массив не пропускаются', () => {
    // Иначе одним разрешённым именем протащили бы структуру целиком.
    expect(pickSafeAttributes({ outcome: { text: 'ужасно' } })).toEqual({})
    expect(pickSafeAttributes({ outcome: ['ужасно'] })).toEqual({})
    expect(pickSafeAttributes({ 'result.count': { n: 1 } })).toEqual({})
  })

  it('значение обрезается и схлопывается в одну строку', () => {
    // Атрибут — метка, а не поле для содержимого; перевод строки позволяет подделать соседнее поле
    // в текстовых бэкендах.
    const long = pickSafeAttributes({ outcome: 'я'.repeat(500) })
    expect(long.outcome).toHaveLength(MAX_ATTRIBUTE_LENGTH)
    expect(pickSafeAttributes({ outcome: ' a\nb\tc ' }).outcome).toBe('a b c')
    expect(pickSafeAttributes({ outcome: '   ' })).toEqual({})
  })

  it('пустое и нечисловое не превращается в мусорный атрибут', () => {
    expect(pickSafeAttributes({ outcome: undefined, 'result.count': null })).toEqual({})
    expect(pickSafeAttributes({ 'result.count': Number.NaN })).toEqual({})
    expect(pickSafeAttributes({ 'result.count': Number.POSITIVE_INFINITY })).toEqual({})
  })

  it('список не пуст и в нём нет имён, похожих на данные людей', () => {
    // Гард против пополнения «на автомате»: имя вида `answer`/`text`/`name`/`phone`/`email` в этом
    // списке означает, что кто-то открыл дорогу содержимому.
    expect(TELEMETRY_ATTRIBUTES.length).toBeGreaterThan(5)
    for (const name of TELEMETRY_ATTRIBUTES) {
      expect(name, `${name}: имя допускает содержимое`).not.toMatch(
        /answer|text|name|phone|email|comment|title|body|statement|query|token|secret|member/i
      )
    }
  })
})

describe('portalHash — заказчик не назван', () => {
  it('member_id не восстанавливается из значения и стабилен', () => {
    const h = portalHash('abc123')
    expect(h).toBeDefined()
    expect(h).not.toContain('abc123')
    expect(h).toHaveLength(PORTAL_HASH_LENGTH)
    expect(h).toMatch(/^[0-9a-f]+$/)
    expect(portalHash('abc123')).toBe(h) // тот же портал — тот же ключ
    expect(portalHash('abc124')).not.toBe(h) // другой — другой
  })

  it('пусто → атрибута нет, а не строка «undefined»', () => {
    for (const raw of [undefined, '', '   ']) expect(portalHash(raw)).toBeUndefined()
  })
})

describe('errorKind — вид вместо текста', () => {
  it('вид не содержит исходного текста', () => {
    // Ровно тот канал утечки, из-за которого текст не отдаётся: строка подключения и адрес с токеном.
    const leaky = new Error('connect ECONNREFUSED postgres://user:p@ss@db:5432/polls')
    const kind = errorKind(leaky)
    expect(ERROR_KINDS).toContain(kind)
    expect(kind).not.toContain('p@ss')
    expect(kind).not.toContain('postgres')
  })

  it('узнаёт виды, по которым принимают решения', () => {
    expect(errorKind(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('timeout')
    expect(errorKind(new Error('Request timed out after 10000ms'))).toBe('timeout')
    expect(errorKind(new Error('fetch failed'))).toBe('network')
    expect(errorKind(new Error('invalid_grant'))).toBe('auth')
    expect(errorKind(new Error('QUERY_LIMIT_EXCEEDED'))).toBe('rate_limit')
    expect(errorKind(new Error('Bitrix24 crm.deal.get: NOT_FOUND'))).toBe('not_found')
    expect(errorKind(new Error('Bitrix24 crm.deal.get: пустой ответ'))).toBe('other')
  })

  it('что угодно на входе → всегда вид из закрытого набора', () => {
    for (const e of [null, undefined, 42, {}, [], 'строка', new Error('')]) {
      expect(ERROR_KINDS, String(e)).toContain(errorKind(e))
    }
  })
})

describe('telemetryEnabled', () => {
  it('нет адреса коллектора → выключено', () => {
    expect(telemetryEnabled({})).toBe(false)
    expect(telemetryEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: '' })).toBe(false)
    expect(telemetryEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: '   ' })).toBe(false)
  })

  it('есть адрес → включено', () => {
    expect(telemetryEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' })).toBe(true)
  })
})

/**
 * Гарды на код: правила приватности должны держаться структурно, а не памятью автора.
 */
describe('спаны нельзя наполнить в обход белого списка', () => {
  const span = readFileSync(join(ROOT, 'src/obs/span.ts'), 'utf8')

  it('recordException не используется НИГДЕ в ядре', () => {
    // Он кладёт в спан `exception.message` и `exception.stacktrace` — свободный текст из чужой
    // библиотеки, то есть ровно тот канал, ради закрытия которого написан errorKind.
    // Комментарии снимаем: запрет — на КОД, а объяснять запрет в JSDoc не только можно, но и нужно —
    // иначе следующий автор добавит вызов, не зная, почему его здесь нет.
    for (const file of listFiles(join(ROOT, 'src'))) {
      const code = stripComments(readFileSync(file, 'utf8'))
      expect(code.includes('recordException'), `${file}: текст и стек ошибки уедут в трейс`).toBe(false)
    }
  })

  it('статусу спана не передаётся message', () => {
    // `setStatus({ code, message })` — второе поле для свободной строки.
    expect(stripComments(span)).not.toMatch(/setStatus\([^)]*message/)
  })

  it('атрибуты спана идут только через белый список', () => {
    const code = stripComments(span)
    expect(code).toContain('pickSafeAttributes(attrs)')
    // Единственный прямой setAttribute — наш собственный `error_kind`; всё прочее обязано идти
    // через белый список, иначе обёртка перестаёт быть гарантией.
    const direct = code.match(/setAttribute\(\s*'([^']+)'/g) ?? []
    expect(direct).toEqual(["setAttribute('error_kind'"])
  })

  it('исходящие вызовы к порталу обёрнуты в единой точке', () => {
    // Обёртка по месту вызова означала бы, что каждый новый вызов нужно не забыть обернуть.
    const client = stripComments(readFileSync(join(ROOT, 'src/bitrix24/client.ts'), 'utf8'))
    expect(client).toContain('withDependencySpan(')
    // В атрибуты не должны попасть параметры вызова: там id сделки и поля CRM.
    expect(client).not.toMatch(/withDependencySpan\([^)]*params/)
  })
})

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []
  )
}

/**
 * Поведение обёртки на РАБОТАЮЩЕМ трейсере.
 *
 * Гарды выше читают исходник; этот блок его исполняет. Без него «в спан попадает только разрешённое»
 * оставалось бы утверждением о тексте файла, а не о том, что реально уедет в коллектор.
 */
describe('withSpan — что реально попадает в спан', () => {
  interface Captured { name: string, attrs: Record<string, unknown>, later: Record<string, unknown>, status?: { code: number, message?: string } }
  const captured: Captured[] = []

  beforeAll(() => {
    trace.setGlobalTracerProvider({
      getTracer: () => ({
        startActiveSpan: (name: string, opts: { attributes?: Record<string, unknown> }, fn: (s: unknown) => unknown) => {
          const rec: Captured = { name, attrs: opts.attributes ?? {}, later: {} }
          captured.push(rec)
          return fn({
            setAttribute: (k: string, v: unknown) => { rec.later[k] = v },
            setStatus: (st: { code: number, message?: string }) => { rec.status = st },
            end: () => {}
          })
        }
      })
    } as never)
  })

  afterAll(() => { trace.disable() })

  it('данные респондента и токен в спан не попадают, даже если их передали', async () => {
    captured.length = 0
    const out = await withDependencySpan('b24 crm.deal.get', {
      'b24.method': 'crm.deal.get',
      answer: 'Всё ужасно, звоните +375291234567',
      contactName: 'Иванов Иван',
      accessToken: 'секрет'
    }, async () => 'готово')

    expect(out).toBe('готово')
    expect(captured).toHaveLength(1)
    expect(captured[0]?.attrs).toEqual({ 'b24.method': 'crm.deal.get' })
    const dump = JSON.stringify(captured)
    for (const leak of ['ужасно', 'Иванов', '375291234567', 'секрет']) {
      expect(dump, `${leak} уехал в спан`).not.toContain(leak)
    }
  })

  it('на ошибке уходит ВИД, а не текст, и статус без message', async () => {
    captured.length = 0
    const leaky = new Error('connect ECONNREFUSED postgres://user:p@ss@db/polls')
    await expect(withSpan('fail', { outcome: 'x' }, async () => { throw leaky }))
      .rejects.toThrow(leaky) // телеметрия не глотает ошибку
    expect(captured[0]?.later).toEqual({ error_kind: 'network' })
    expect(captured[0]?.status?.code).toBe(2) // ERROR
    expect(captured[0]?.status?.message).toBeUndefined()
    const dump = JSON.stringify(captured)
    for (const leak of ['p@ss', 'postgres', 'ECONNREFUSED']) {
      expect(dump, `${leak} уехал в спан`).not.toContain(leak)
    }
  })

  it('успех помечается OK', async () => {
    captured.length = 0
    await withSpan('ok', {}, async () => 1)
    expect(captured[0]?.status?.code).toBe(1)
  })
})

describe('withSpan без SDK — полный no-op', () => {
  it('значение возвращается, ошибка пробрасывается', async () => {
    // Заявленное состояние по умолчанию: нет коллектора — нет телеметрии, и поведение кода то же.
    trace.disable()
    expect(await withSpan('t', { outcome: 'ok' }, async () => 42)).toBe(42)
    const boom = new Error('бум')
    await expect(withSpan('t', {}, async () => { throw boom })).rejects.toThrow(boom)
  })
})
