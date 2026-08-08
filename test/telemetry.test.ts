import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { SpanKind, trace } from '@opentelemetry/api'
import { callMethod } from '../src/bitrix24/client'
import { withDependencySpan, withSpan } from '../src/obs/span'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ERROR_KINDS,
  MAX_ATTRIBUTE_LENGTH,
  MAX_SPAN_NAME_LENGTH,
  PORTAL_HASH_LENGTH,
  TELEMETRY_ATTRIBUTES,
  errorKind,
  pickSafeAttributes,
  portalHash,
  telemetryEnabled,
  outgoingCallAttributes,
  OUTGOING_STAGES
} from '../src/obs/telemetry'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Один провайдер на весь файл с ПОДМЕНЯЕМЫМ обработчиком.
 *
 * Трейсер мемоизирован в `src/obs/span.ts` (один на модуль — штатная практика OTel), поэтому
 * `trace.disable()` в одном тесте оставлял прокси в no-op и ломал следующий: тесты зависели от порядка.
 * Здесь провайдер ставится один раз, а тест меняет только обработчик.
 *
 * `hook = null` соответствует состоянию «SDK не зарегистрирован»: настоящий no-op-трейсер тоже просто
 * вызывает колбэк с неучитываемым спаном и никуда ничего не отправляет.
 */
type Hook = (name: string, opts: { attributes?: Record<string, unknown>, kind?: number }, fn: (s: unknown) => unknown) => unknown
let hook: Hook | null = null
const noopSpan = { setAttribute: () => {}, setStatus: () => {}, end: () => {} }

beforeAll(() => {
  trace.setGlobalTracerProvider({
    getTracer: () => ({
      startActiveSpan: (name: string, opts: never, fn: (s: unknown) => unknown) =>
        hook ? hook(name, opts, fn) : fn(noopSpan)
    })
  } as never)
})
afterEach(() => { hook = null })


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
      stage: 'profile'
    })).toEqual({
      'portal.hash': 'deadbeefdeadbeef',
      'b24.method': 'crm.deal.get',
      stage: 'profile'
    })
  })

  it('только скаляры: объект или массив не пропускаются', () => {
    // Иначе одним разрешённым именем протащили бы структуру целиком.
    expect(pickSafeAttributes({ stage: { text: 'ужасно' } })).toEqual({})
    expect(pickSafeAttributes({ stage: ['ужасно'] })).toEqual({})
    expect(pickSafeAttributes({ 'b24.method': { n: 1 } })).toEqual({})
  })

  it('под разрешённым именем свободный текст НЕ проходит', () => {
    // Главная находка ревью: список фильтровал только ИМЕНА, и значение под разрешённым именем шло
    // дословно — то есть `{ stage: текстОтвета }` уезжал в трейс целиком, а все проверки оставались
    // зелёными. Теперь каждое имя объявляет форму значения, и свободного текста не бывает вовсе.
    expect(pickSafeAttributes({ stage: 'Всё ужасно, звоните Иванову +375291234567' })).toEqual({})
    expect(pickSafeAttributes({ stage: 'я'.repeat(500) })).toEqual({})
    expect(pickSafeAttributes({ 'b24.method': 'Иванов Иван' })).toEqual({})
    expect(pickSafeAttributes({ 'portal.hash': 'acme.bitrix24.by' })).toEqual({})
    expect(pickSafeAttributes({ error_kind: 'connect ECONNREFUSED postgres://u:p@db' })).toEqual({})
    // А форма из закрытого набора — проходит.
    expect(pickSafeAttributes({ stage: 'profile' })).toEqual({ stage: 'profile' })
    expect(pickSafeAttributes({ error_kind: 'network' })).toEqual({ error_kind: 'network' })
  })

  it('управляющие и bidi-символы вычищаются, а не проходят насквозь', () => {
    // Проверяющий показал, что `\s+` их не покрывает: NUL, ESC, RLO и zero-width сохранялись. В
    // терминальном просмотрщике оператора ESC перекрашивает и подделывает соседние поля, RLO
    // переворачивает текст. Форма значения теперь узкая, поэтому такой мусор ещё и не пройдёт правило.
    expect(pickSafeAttributes({ 'b24.method': 'crm.deal\u0000.get' })).toEqual({ 'b24.method': 'crm.deal.get' })
    expect(pickSafeAttributes({ 'b24.method': 'crm\u001b[2J.deal.get' })).toEqual({})
    expect(pickSafeAttributes({ stage: 'pro\u202efile' })).toEqual({ stage: 'profile' })
    expect(pickSafeAttributes({ stage: 'pro\u200bfile' })).toEqual({ stage: 'profile' })
  })

  it('пробелы схлопываются, пустое отбрасывается', () => {
    expect(pickSafeAttributes({ stage: ' profile ' })).toEqual({ stage: 'profile' })
    expect(pickSafeAttributes({ stage: '   ' })).toEqual({})
  })

  it('пустое и нечисловое не превращается в мусорный атрибут', () => {
    expect(pickSafeAttributes({ stage: undefined, 'b24.method': null })).toEqual({})
    // Числовых имён в списке сейчас нет — числовое значение не пройдёт правило ни под одним именем.
    expect(pickSafeAttributes({ stage: Number.NaN as unknown as string })).toEqual({})
    expect(pickSafeAttributes({ stage: 42 as unknown as string })).toEqual({})
  })

  it('список не пуст и в нём нет имён, похожих на данные людей', () => {
    // Гард против пополнения «на автомате»: имя вида `answer`/`text`/`name`/`phone`/`email` в этом
    // списке означает, что кто-то открыл дорогу содержимому.
    // Пиннем СОСТАВ, а не размер: имя пополняется только вместе с местом вызова (критерий #31),
    // и молчаливое пополнение «на будущее» — то, что здесь нужно поймать.
    expect([...TELEMETRY_ATTRIBUTES].sort()).toEqual(['b24.method', 'error_kind', 'portal.hash', 'stage'])
    for (const name of TELEMETRY_ATTRIBUTES) {
      expect(name, `${name}: имя допускает содержимое`).not.toMatch(
        /answer|text|name|phone|email|comment|title|body|statement|query|token|secret|member/i
      )
    }
  })
})

describe('outgoingCallAttributes — домен заказчика не уезжает', () => {
  it('стадия из закрытого набора, домен только хешем', () => {
    // В адресе портала стоит его домен, то есть имя заказчика. В спан идёт хеш, не адрес.
    const a = outgoingCallAttributes('https://acme.bitrix24.by/rest/profile')
    expect(a.stage).toBe('profile')
    expect(a['portal.hash']).toBe(portalHash('acme.bitrix24.by'))
    expect(JSON.stringify(a)).not.toContain('acme')
    expect(JSON.stringify(a)).not.toContain('bitrix24.by')
  })

  it('OAuth-сервер: стадия есть, хеша нет (хост один на всех)', () => {
    const a = outgoingCallAttributes('https://oauth.bitrix.info/oauth/token/')
    expect(a).toEqual({ stage: 'oauth.refresh' })
  })

  it('незнакомый адрес и мусор → стадия из набора, ничего лишнего', () => {
    expect(OUTGOING_STAGES).toContain(outgoingCallAttributes('https://acme.bitrix24.by/rest/crm.deal.get').stage)
    expect(outgoingCallAttributes('не-адрес')).toEqual({ stage: 'other' })
    expect(outgoingCallAttributes('')).toEqual({ stage: 'other' })
  })

  it('токен в query не попадает в атрибуты', () => {
    // Часть путей Bitrix принимает auth в query; адрес в спан не кладём вовсе, поэтому утечки нет.
    const a = outgoingCallAttributes('https://acme.bitrix24.by/rest/profile?auth=СЕКРЕТ')
    expect(JSON.stringify(a)).not.toContain('СЕКРЕТ')
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

  /**
   * ⚠️ Область — `src/` + `server/` + `app/`, а не только ядро. Ревью показало цену узкой области:
   * `recordException` и `setStatus({ message })`, добавленные в `server/api/health.get.ts`, оставляли
   * все 21 тест зелёными. Спаны с данными портала появятся именно в `server/`.
   */
  const SURFACES = ['src', 'server', 'app']
  const allFiles = SURFACES.flatMap((d) => listFiles(join(ROOT, d)))

  it('область гардов покрывает все три поверхности', () => {
    // Иначе гард зелёный «ни на чём»: файлы не нашлись — проверок не было.
    expect(allFiles.length).toBeGreaterThan(40)
    for (const d of SURFACES) expect(allFiles.some((f) => f.includes(`/${d}/`)), d).toBe(true)
  })

  it('утечки через API спана запрещены во всём приложении', () => {
    // `recordException` кладёт message и стек; `addEvent`/`setAttributes` — произвольные поля мимо
    // белого списка. Комментарии снимаем: запрет на КОД, а объяснять запрет в JSDoc нужно.
    for (const file of allFiles) {
      const code = stripComments(readFileSync(file, 'utf8'))
      for (const banned of ['recordException', '.addEvent(', '.setAttributes(']) {
        expect(code.includes(banned), `${file}: ${banned} — поле мимо белого списка`).toBe(false)
      }
      expect(code, `${file}: текст ошибки в статусе спана`).not.toMatch(/setStatus\([^)]*message/)
    }
  })

  it('спаны создаются ТОЛЬКО обёрткой', () => {
    // Обёртка — безопасный путь, но пока она не единственный доступный, гарантия держится на памяти
    // автора: `trace.getTracer(...).startActiveSpan(n, { attributes: { answer } })` можно написать где
    // угодно и обойти белый список целиком.
    const allowed = join(ROOT, 'src/obs/span.ts')
    for (const file of allFiles) {
      if (file === allowed) continue
      const code = stripComments(readFileSync(file, 'utf8'))
      for (const banned of ['startActiveSpan', 'getTracer(', 'startSpan(']) {
        expect(code.includes(banned), `${file}: спан в обход обёртки (${banned})`).toBe(false)
      }
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


  it('данные респондента и токен в спан не попадают, даже если их передали', async () => {
    captured.length = 0
    hook = (name, opts, fn) => {
      const rec: Captured = { name, attrs: opts.attributes ?? {}, later: {} }
      captured.push(rec)
      return fn({
        setAttribute: (k: string, v: unknown) => { rec.later[k] = v },
        setStatus: (st: { code: number, message?: string }) => { rec.status = st },
        end: () => {}
      })
    }
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
    hook = (name, opts, fn) => {
      const rec: Captured = { name, attrs: opts.attributes ?? {}, later: {} }
      captured.push(rec)
      return fn({
        setAttribute: (k: string, v: unknown) => { rec.later[k] = v },
        setStatus: (st: { code: number, message?: string }) => { rec.status = st },
        end: () => {}
      })
    }
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
    hook = (name, opts, fn) => {
      const rec: Captured = { name, attrs: opts.attributes ?? {}, later: {} }
      captured.push(rec)
      return fn({
        setAttribute: (k: string, v: unknown) => { rec.later[k] = v },
        setStatus: (st: { code: number, message?: string }) => { rec.status = st },
        end: () => {}
      })
    }
    await withSpan('ok', {}, async () => 1)
    expect(captured[0]?.status?.code).toBe(1)
  })
})

describe('withSpan без SDK — полный no-op', () => {
  it('значение возвращается, ошибка пробрасывается', async () => {
    // Заявленное состояние по умолчанию: нет коллектора — нет телеметрии, и поведение кода то же.
    hook = null
    expect(await withSpan('t', { stage: 'other' }, async () => 42)).toBe(42)
    const boom = new Error('бум')
    await expect(withSpan('t', {}, async () => { throw boom })).rejects.toThrow(boom)
  })
})

describe('охват: вызовы мимо callMethod тоже обёрнуты', () => {
  it('точка инъекции fetch несёт спан', () => {
    // `callMethod` покрывает только REST через SDK. Проверка фрейм-токена (`/rest/profile`) и рефреш
    // OAuth-токена идут мимо него — через инжектируемый `HttpFetch`, и спан обязан быть там.
    const code = readFileSync(join(ROOT, 'server/utils/b24-fetch.ts'), 'utf8')
    expect(code).toContain('withDependencySpan(')
    expect(code).toContain('outgoingCallAttributes(')
    // Сам URL в спан не кладём: в нём домен заказчика и иногда токен.
    expect(stripComments(code)).not.toMatch(/withDependencySpan\([^;]*['\`]\$\{url\}/)
  })
})

/**
 * Телеметрия не имеет права менять то, что увидит вызывающий, — в том числе собственным сбоем.
 * Каждая находка ниже проверена проверяющим на исполнении, а не предположена.
 */
describe('сбой телеметрии не подменяет результат', () => {
  it('errorKind не бросает на ошибке с враждебным геттером message', () => {
    // Иначе исключение вылетело бы ИЗ catch-блока обёртки и подменило настоящую ошибку вызывающего.
    class Nasty extends Error {
      override get message(): string { throw new Error('геттер сломан') }
    }
    expect(errorKind(new Nasty())).toBe('other')
  })

  it('portalHash не бросает на не-строке', () => {
    // member_id приходит из JSON-тел и строк БД, где типу верят на слово; TypeError здесь стал бы
    // 500 в роуте из-за телеметрии.
    for (const bad of [123, {}, [], true, Symbol('x'), null, undefined]) {
      expect(() => portalHash(bad as unknown as string), String(bad)).not.toThrow()
      expect(portalHash(bad as unknown as string)).toBeUndefined()
    }
  })

  it('сломанный трейсер: операция ВЫПОЛНЯЕТСЯ и её результат доходит', async () => {
    // Ревью показало: без защиты синхронный throw в startActiveSpan отменял бизнес-вызов, а throw в
    // setStatus/end превращал успех в ошибку. Анонсированный redaction-процессор вызывается синхронно
    // в onStart — то есть один баг в нём убил бы все вызовы к порталу.
    let ran = false
    hook = () => { throw new Error('трейсер сломан') }
    const out = await withSpan('t', { stage: 'other' }, async () => { ran = true; return 'ЗНАЧЕНИЕ' })
    expect(ran, 'операция не выполнилась').toBe(true)
    expect(out).toBe('ЗНАЧЕНИЕ')
  })

  it('сломанные setStatus/end: успех остаётся успехом, ошибка — той же ошибкой', async () => {
    hook = (_n, _o, fn) => fn({
      setAttribute: () => { throw new Error('экспортёр сломан') },
      setStatus: () => { throw new Error('экспортёр сломан') },
      end: () => { throw new Error('экспортёр сломан') }
    })
    expect(await withSpan('ok', { stage: 'other' }, async () => 'ЗНАЧЕНИЕ')).toBe('ЗНАЧЕНИЕ')
    const boom = new Error('настоящая ошибка')
    await expect(withSpan('fail', { stage: 'other' }, async () => { throw boom })).rejects.toThrow(boom)
  })
})

describe('callMethod: params не попадают в спан (исполнение, не греп)', () => {
  it('id сделки и поля CRM в спане отсутствуют', async () => {
    // Текстовый гард обходился одной промежуточной переменной: `const p = JSON.stringify(params)` и
    // дальше `{ outcome: p }` — проверяющий показал, что все тесты при этом зелёные. Поэтому здесь
    // спан перехватывается и проверяется его содержимое.
    const seen: Array<{ name: string, attrs: Record<string, unknown> }> = []
    hook = (name, opts, fn) => {
      seen.push({ name, attrs: { ...(opts.attributes ?? {}), __kind: opts.kind } })
      return fn(noopSpan)
    }

    const client = {
      actions: { v2: { call: { make: async () => ({
        isSuccess: true,
        getData: () => ({ result: { ok: 1 } }),
        getErrorMessages: () => []
      }) } } }
    }
    const params = { id: 759, TITLE: 'ООО Ромашка', PHONE: '+375291234567' }
    await callMethod(client as never, 'crm.deal.get', params)

    expect(seen).toHaveLength(1)
    expect(seen[0]?.attrs['b24.method']).toBe('crm.deal.get')
    const dump = JSON.stringify(seen)
    for (const leak of ['759', 'Ромашка', '375291234567', 'TITLE', 'PHONE']) {
      expect(dump, `${leak} уехал в спан`).not.toContain(leak)
    }
    // Вид спана — CLIENT (2): по нему в коллекторе отделяют «ждём чужой сервис» от «считаем сами».
    expect(seen[0]?.attrs.__kind).toBe(SpanKind.CLIENT)
  })
})

describe('имя спана — второй канал тех же данных', () => {
  it('враждебное имя вычищается и капается', async () => {
    // Белый список имени спана не касается, а имя уезжает в трейс так же. Без вычистки
    // `withSpan(err.message, …)` отправил бы текст ошибки мимо всей защиты.
    let seen = ''
    hook = (name, _o, fn) => { seen = name; return fn(noopSpan) }
    await withSpan(`ответ: ужасно\u001b[2J\u0000\u202e +375291234567 ${'я'.repeat(300)}`, {}, async () => 1)
    expect(seen.length).toBeLessThanOrEqual(MAX_SPAN_NAME_LENGTH)
    for (const bad of ['\u001b', '\u0000', '\u202e']) {
      expect(seen, 'управляющий символ в имени спана').not.toContain(bad)
    }
  })

  it('пустое имя не превращается в пустую строку', async () => {
    // Безымянный спан в интерфейсе коллектора неотличим от сбоя.
    let seen = 'не вызвано'
    hook = (name, _o, fn) => { seen = name; return fn(noopSpan) }
    await withSpan('   ', {}, async () => 1)
    expect(seen).toBe('unnamed')
  })
})
