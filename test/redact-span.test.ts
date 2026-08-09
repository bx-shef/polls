import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  KNOWN_LEAKY_ATTRIBUTES,
  OWN_ATTRIBUTE_PREFIXES,
  SAFE_FOREIGN_ATTRIBUTES,
  SAFE_RESOURCE_ATTRIBUTES,
  isOwnAttribute,
  redactResourceAttributes,
  redactSpanAttributes
} from '../src/obs/redact-span'

const BOOTSTRAP = fileURLToPath(new URL('../otel.instrument.mjs', import.meta.url))

/**
 * Белый список из `telemetry.ts` управляет тем, что кладём МЫ. Здесь — то, что кладёт авто-
 * инструментирование чужих библиотек, ни о каком нашем списке не знающее. Это и есть та половина
 * защиты, ради которой перенос телеметрии разбит на два шага.
 */
describe('redactSpanAttributes — чужие атрибуты', () => {
  it('ВСЕ известные утечки отбрасываются поимённо', () => {
    // Не «незнакомое отбрасывается» (это тавтология при белом списке), а именно эти имена — они взяты
    // из реальных инструментаций `http`/`pg`/`undici`, и каждое разобрано в шапке модуля.
    const attrs = Object.fromEntries(KNOWN_LEAKY_ATTRIBUTES.map((k) => [k, 'значение']))
    expect(redactSpanAttributes(attrs)).toEqual({})
  })

  it('токен доступа из пути опроса и дашборда не уезжает', () => {
    // В `/s/:key` и `/d/:key` лежат не идентификаторы, а КЛЮЧИ: первый открывает прохождение опроса,
    // второй — дашборд заказчика.
    const out = redactSpanAttributes({
      'url.path': '/s/csat_postdeal?token=СЕКРЕТ',
      'http.target': '/d/csat_postdeal',
      'url.full': 'https://acme.bitrix24.by/rest/profile?auth=ТОКЕН'
    })
    expect(out).toEqual({})
    expect(JSON.stringify(out)).not.toContain('СЕКРЕТ')
  })

  it('адрес респондента не уезжает — иначе рушится порог анонимности', () => {
    // Самое неприятное: адрес вместе с меткой времени спана джойнится с анонимной строкой ответа, и
    // порог 5 обходится не через агрегаты, которые мы защищали, а через трейсы.
    expect(redactSpanAttributes({ 'client.address': '203.0.113.7', 'net.peer.ip': '203.0.113.7' }))
      .toEqual({})
  })

  it('текст SQL и параметры запроса не уезжают', () => {
    expect(redactSpanAttributes({
      'db.statement': "INSERT INTO response_answer (text) VALUES ('всё ужасно')",
      'db.statement.parameters': ['всё ужасно']
    })).toEqual({})
  })

  it('исключения чужих инструментаций не уезжают', () => {
    // У себя мы запретили `recordException`; чужой код о запрете не знает.
    expect(redactSpanAttributes({
      'exception.message': 'connect ECONNREFUSED postgres://user:p@ss@db/polls',
      'exception.stacktrace': 'at Object.<anonymous> (/app/src/store/pg.ts:42)'
    })).toEqual({})
  })

  it('безопасные чужие атрибуты остаются — иначе трейс бесполезен', () => {
    // Глаголы, коды и имена систем: содержимым они не бывают, а без них спан ничего не объясняет.
    const keep = {
      'http.request.method': 'POST',
      'http.response.status_code': 413,
      'url.scheme': 'https',
      'http.route': '/s/:key',
      'db.system': 'postgresql'
    }
    expect(redactSpanAttributes(keep)).toEqual(keep)
  })

  it('шаблон маршрута остаётся, заполненный путь — нет', () => {
    // Разница принципиальная: `http.route` — это `/s/:key`, ключ в нём НЕ заполнен.
    const out = redactSpanAttributes({ 'http.route': '/s/:key', 'url.path': '/s/секретный-ключ' })
    expect(out).toEqual({ 'http.route': '/s/:key' })
  })

  it('наши собственные атрибуты не выбрасываются', () => {
    // Их уже проверил белый список `telemetry.ts` — и по имени, и по форме значения.
    const own = { 'portal.hash': 'deadbeefdeadbeef', 'b24.method': 'crm.deal.get', error_kind: 'auth', stage: 'profile' }
    expect(redactSpanAttributes(own)).toEqual(own)
  })

  it('чужое имя с нашим префиксом не проходит по случайности', () => {
    expect(isOwnAttribute('portal.hash')).toBe(true)
    expect(isOwnAttribute('b24.method')).toBe(true)
    expect(isOwnAttribute('stage')).toBe(true)
    // `stage` — точное имя, а не префикс: `stagehistory` чужое.
    expect(isOwnAttribute('stagehistory')).toBe(false)
    expect(isOwnAttribute('error_kind_detail')).toBe(false)
  })

  it('undefined не превращается в атрибут', () => {
    expect(redactSpanAttributes({ 'http.route': undefined, 'db.statement': undefined })).toEqual({})
  })
})

describe('redactResourceAttributes — про машину, а не про сервис', () => {
  it('топология инфраструктуры не уезжает', () => {
    // Приёмник общий; разглашать ему имя хоста, аргументы запуска (там бывает строка подключения) и
    // владельца процесса незачем.
    expect(redactResourceAttributes({
      'host.name': 'polls-prod-1',
      'process.command_args': ['node', '--env-file=.env.prod'],
      'process.owner': 'node',
      'process.pid': 42
    })).toEqual({})
  })

  it('имя сервиса остаётся — без него трейсы не с чем сопоставить', () => {
    expect(redactResourceAttributes({ 'service.name': 'polls' })).toEqual({ 'service.name': 'polls' })
  })
})

/**
 * Parity: бутстрап — обычный `.mjs`, он грузится ДО сборки и наш TypeScript импортировать не может,
 * поэтому списки в нём продублированы. Дубль без сверки разъезжается молча — и разъедется он в
 * опасную сторону: в ядре имя уберут, а в бутстрапе оно останется разрешённым.
 */
describe('бутстрап SDK не разъезжается с ядром', () => {
  const source = readFileSync(BOOTSTRAP, 'utf8')

  const listFrom = (name: string): string[] => {
    const m = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(source)
    expect(m, `список ${name} не найден в бутстрапе — изменилась запись?`).not.toBeNull()
    return [...(m?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1] as string)
  }

  it('список безопасных чужих атрибутов совпадает', () => {
    expect(listFrom('SAFE_FOREIGN_ATTRIBUTES')).toEqual([...SAFE_FOREIGN_ATTRIBUTES])
  })

  it('список наших префиксов совпадает', () => {
    expect(listFrom('OWN_ATTRIBUTE_PREFIXES')).toEqual([...OWN_ATTRIBUTE_PREFIXES])
  })

  it('бутстрап не делает ничего без адреса коллектора', () => {
    // Единственный рычаг. Если условие уедет, телеметрия включится там, где её не ждут.
    expect(source).toContain("process.env.OTEL_EXPORTER_OTLP_ENDPOINT")
    expect(source).toMatch(/if \(endpoint\)/)
  })

  it('вычистка стоит ПЕРЕД экспортом', () => {
    // `MultiSpanProcessor` зовёт `onEnd` по порядку: спан, дошедший до экспортёра нередактированным,
    // уже не вернуть.
    const redact = source.indexOf('new RedactingSpanProcessor()')
    const exportIdx = source.indexOf('new BatchSpanProcessor(')
    expect(redact).toBeGreaterThan(-1)
    expect(exportIdx).toBeGreaterThan(-1)
    expect(redact, 'вычистка стоит после экспорта — спан уедет нетронутым').toBeLessThan(exportIdx)
  })

  it('параметры SQL-запросов выключены явно', () => {
    // `enhancedDatabaseReporting: true` кладёт в спан значения полей — то есть тексты ответов.
    expect(source).toMatch(/enhancedDatabaseReporting:\s*false/)
  })

  it('файловая инструментация выключена', () => {
    expect(source).toMatch(/instrumentation-fs'?\]?:\s*\{\s*enabled:\s*false/)
  })
})

describe('политика — белый список, а не список запретов', () => {
  it('в ядре нет перечня «запрещённых» имён как механизма вычистки', () => {
    // Список «выбросить» устаревает молча: семантические соглашения OTel переименовывают атрибуты
    // между версиями (`http.url` → `url.full`, `net.peer.ip` → `client.address`), и обновление
    // инструментации тихо открывает то, что вчера было закрыто.
    const core = readFileSync(fileURLToPath(new URL('../src/obs/redact-span.ts', import.meta.url)), 'utf8')
    // Только ТЕЛО функции: дальше в файле лежит сам перечень, и он там законно — для тестов.
    const from = core.indexOf('export function redactSpanAttributes')
    const body = core.slice(from, core.indexOf('\n}', from))
    expect(body).not.toContain('KNOWN_LEAKY_ATTRIBUTES')
    expect(body).toContain('allowed.has(key)')
  })

  it('перечень известных утечек не пуст и покрывает обе семьи имён', () => {
    // Он нужен тестам, а не вычистке: проверять «вот именно ЭТО отбрасывается» на реальных именах.
    expect(KNOWN_LEAKY_ATTRIBUTES.length).toBeGreaterThan(15)
    expect(KNOWN_LEAKY_ATTRIBUTES).toContain('http.url') // старое имя
    expect(KNOWN_LEAKY_ATTRIBUTES).toContain('url.full') // новое имя того же
    expect(SAFE_FOREIGN_ATTRIBUTES.length).toBeGreaterThan(5)
    expect(SAFE_RESOURCE_ATTRIBUTES).toContain('service.name')
  })
})

describe('preload-пакет и бандл приложения не расходятся по версии', () => {
  it('версия @opentelemetry/api совпадает точно', () => {
    // ⚠️ Самая тихая поломка во всём переносе: регистрация SDK идёт через глобальный символ, и он
    // совместим только при совпадающих версиях. Разойдутся — трейсов не будет НИКОГДА, без ошибки и
    // без записи в логе. Dependabot бампнет одну сторону, и телеметрия молча умрёт.
    const app = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
    const preload = JSON.parse(readFileSync(fileURLToPath(new URL('../otel-preload-package.json', import.meta.url)), 'utf8'))
    const appRange = app.dependencies['@opentelemetry/api'] as string
    const preloadPinned = preload.dependencies['@opentelemetry/api'] as string
    // В preload версия ТОЧНАЯ (без ^/~): диапазон дал бы расхождение при первом же обновлении.
    expect(preloadPinned).toMatch(/^\d+\.\d+\.\d+$/)
    expect(appRange.replace(/^[\^~]/, '')).toBe(preloadPinned)
  })

  it('все версии preload запиннены точно', () => {
    const preload = JSON.parse(readFileSync(fileURLToPath(new URL('../otel-preload-package.json', import.meta.url)), 'utf8'))
    const deps = Object.entries(preload.dependencies as Record<string, string>)
    expect(deps.length).toBeGreaterThan(4)
    for (const [name, version] of deps) {
      expect(version, `${name}: диапазон вместо точной версии`).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })

  it('образ грузит бутстрап ДО приложения', () => {
    // `--import` после старта приложения зарегистрируется и не перехватит ничего — молча.
    const dockerfile = readFileSync(fileURLToPath(new URL('../Dockerfile', import.meta.url)), 'utf8')
    expect(dockerfile).toMatch(/NODE_OPTIONS=--import=.*otel\.instrument\.mjs/)
    expect(dockerfile).toMatch(/NODE_PATH=/)
    expect(dockerfile, 'зависимости бутстрапа не скопированы в рантайм').toContain('otel_modules')
  })
})
