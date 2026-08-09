import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Бутстрап телеметрии — ЕДИНСТВЕННЫЙ источник правила вычистки, и он ИСПОЛНЯЕТСЯ здесь, а не грепается.
 *
 * Две вещи, которые привели к такому виду, обе показаны ревью на исполнении:
 *  1. Пока бутстрап проверялся подстроками, **9 из 9 мутаций, полностью убивающих вычистку, оставляли
 *     все тесты зелёными** — включая инверсию условия, при которой в коллектор уезжают ровно
 *     `db.statement`, путь с ключом опроса и адрес респондента, а выбрасывается безопасное.
 *  2. Правило жило ДВАЖДЫ — в `.mjs` и в TS-модуле `src/obs/redact-span.ts`, с разной семантикой
 *     (правка на месте против копии). TS-модуль не импортировался ни одним прод-файлом, то есть был
 *     мёртвым по критерию #31, а его 100% покрытия создавали ложную уверенность. Он удалён.
 *
 * ⚠️ Импорт ДИНАМИЧЕСКИЙ и после снятия переменной окружения: на верхнем уровне бутстрапа стоит
 * `if (endpoint) await start()`, и у разработчика с заданным `OTEL_EXPORTER_OTLP_ENDPOINT` статический
 * импорт полез бы грузить настоящий SDK, которого в devDependencies нет.
 */
type Boot = {
  RedactingSpanProcessor: new () => { onEnd: (s: unknown) => void }
  buildSdkConfig: (deps: Record<string, unknown>, endpoint: string) => {
    spanProcessors: unknown[]
    instrumentations: unknown[]
    resourceDetectors: unknown[]
  }
  isAttributeKept: (key: string) => boolean
  SAFE_FOREIGN_ATTRIBUTES: string[]
  OWN_ATTRIBUTE_PREFIXES: string[]
}
let boot: Boot

beforeAll(async () => {
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  // @ts-expect-error — бутстрап на чистом JS (грузится ДО сборки), деклараций у него нет
  boot = await import('../otel.instrument.mjs') as Boot
})

interface FakeSpan {
  attributes: Record<string, unknown>
  events: Array<{ name: string, attributes?: Record<string, unknown> }>
  status: { code: number, message?: string }
}

/** Спан ровно в том виде, в каком его наполняет авто-инструментирование http/pg/undici. */
const dirtySpan = (): FakeSpan => ({
  attributes: {
    'http.route': '/s/:key',
    'http.request.method': 'POST',
    'db.system': 'postgresql',
    'portal.hash': 'deadbeefdeadbeef',
    stage: 'profile',
    'url.path': '/s/СЕКРЕТНЫЙ-КЛЮЧ',
    'url.full': 'https://acme.bitrix24.by/rest/profile?auth=ТОКЕН',
    'client.address': '203.0.113.7',
    'db.statement': "INSERT INTO response_answer (text) VALUES ('всё ужасно')",
    'user_agent.original': 'Mozilla/5.0'
  },
  events: [{ name: 'exception', attributes: { 'exception.message': 'postgres://user:p@ss@db/polls' } }],
  status: { code: 2, message: 'connect ECONNREFUSED 10.0.0.5:5432' }
})

describe('решение «оставить атрибут» проверяется напрямую', () => {
  it('известные утечки не остаются', () => {
    // Проверяем РЕШЕНИЕ, а не литерал массива: сверка списков обходилась комментарием-обманкой и
    // расширением на месте использования — оба обхода ревью показало зелёными.
    for (const key of [
      'db.statement', 'db.statement.parameters', 'db.user', 'db.name', 'db.connection_string',
      'url.full', 'url.path', 'url.query', 'http.url', 'http.target',
      'server.address', 'net.peer.name', 'net.peer.ip', 'client.address',
      'user_agent.original', 'http.request.header.cookie', 'http.request.header.authorization',
      'exception.message', 'exception.stacktrace', 'host.name', 'process.command_args', 'process.owner'
    ]) {
      expect(boot.isAttributeKept(key), `${key} остался бы в спане`).toBe(false)
    }
  })

  it('безопасное и наше — остаётся', () => {
    for (const key of ['http.request.method', 'http.response.status_code', 'url.scheme', 'http.route', 'db.system']) {
      expect(boot.isAttributeKept(key), key).toBe(true)
    }
    for (const key of ['portal.hash', 'b24.method', 'error_kind', 'stage']) {
      expect(boot.isAttributeKept(key), key).toBe(true)
    }
  })

  it('чужое имя с похожим началом не проходит по случайности', () => {
    expect(boot.isAttributeKept('stagehistory')).toBe(false)
    expect(boot.isAttributeKept('error_kind_detail')).toBe(false)
    expect(boot.isAttributeKept('portalX')).toBe(false)
  })

  it('шаблон маршрута остаётся, заполненный путь — нет', () => {
    // Разница принципиальная: `http.route` — это `/s/:key`, ключ в нём НЕ заполнен, а в `url.path`
    // лежит настоящий ключ доступа к опросу.
    expect(boot.isAttributeKept('http.route')).toBe(true)
    expect(boot.isAttributeKept('url.path')).toBe(false)
  })
})

describe('RedactingSpanProcessor — исполнение', () => {
  it('утечки удаляются из самого объекта спана, безопасное остаётся', () => {
    const span = dirtySpan()
    new boot.RedactingSpanProcessor().onEnd(span)
    expect(Object.keys(span.attributes).sort())
      .toEqual(['db.system', 'http.request.method', 'http.route', 'portal.hash', 'stage'])
    const dump = JSON.stringify(span)
    for (const leak of ['СЕКРЕТНЫЙ-КЛЮЧ', 'ТОКЕН', 'acme', '203.0.113.7', 'всё ужасно', 'p@ss', 'ECONNREFUSED', 'Mozilla']) {
      expect(dump, `${leak} уехал бы в коллектор`).not.toContain(leak)
    }
  })

  it('события вычищаются целиком', () => {
    // `exception.message` и `exception.stacktrace` — тот же свободный текст, из-за которого у себя мы
    // запретили `recordException`. Наш запрет покрывает НАШ код, не чужой.
    const span = dirtySpan()
    new boot.RedactingSpanProcessor().onEnd(span)
    expect(span.events).toHaveLength(0)
  })

  it('текст статуса убирается, код остаётся', () => {
    const span = dirtySpan()
    new boot.RedactingSpanProcessor().onEnd(span)
    expect(span.status.message).toBeUndefined()
    expect(span.status.code).toBe(2)
  })

  it('пустой спан и повторная вычистка не ломают процессор', () => {
    const empty = { attributes: {}, events: [], status: { code: 0 } }
    expect(() => new boot.RedactingSpanProcessor().onEnd(empty)).not.toThrow()
    const span = dirtySpan()
    const p = new boot.RedactingSpanProcessor()
    p.onEnd(span)
    expect(() => p.onEnd(span)).not.toThrow()
  })

  it('на сбой вычистки спан обнуляется, а не выпускается полузачищенным', () => {
    const span = dirtySpan()
    let calls = 0
    const trap = new Proxy(span.attributes, {
      deleteProperty(target, key) {
        if (++calls === 1) throw new Error('вычистка сломалась')
        return Reflect.deleteProperty(target, key)
      }
    })
    const broken = { ...span, attributes: trap }
    new boot.RedactingSpanProcessor().onEnd(broken)
    expect(JSON.stringify(broken.attributes), 'утечки остались после сбоя').not.toContain('ТОКЕН')
  })
})

describe('buildSdkConfig — конвейер собирается правильно', () => {
  const deps = {
    resourceFromAttributes: (a: unknown) => ({ resource: a }),
    BatchSpanProcessor: class { constructor(readonly exporter: unknown) {} },
    OTLPTraceExporter: class { constructor(readonly opts: { url: string }) {} }
  }

  it('вычистка стоит ПЕРЕД экспортом', () => {
    // `MultiSpanProcessor` зовёт `onEnd` по порядку: спан, дошедший до экспортёра нередактированным,
    // уже не вернуть. Проверяем ПОРЯДОК в собранном конвейере, а не упоминание в исходнике.
    const cfg = boot.buildSdkConfig(deps, 'http://collector:4318')
    expect(cfg.spanProcessors).toHaveLength(2)
    expect(cfg.spanProcessors[0]).toBeInstanceOf(boot.RedactingSpanProcessor)
    expect(cfg.spanProcessors[1]).toBeInstanceOf(deps.BatchSpanProcessor)
  })

  it('детекторы ресурса ОТКЛЮЧЕНЫ', () => {
    // По умолчанию NodeSDK включает host/process-детекторы, и в каждый спан уезжают `host.name`,
    // `process.owner`, `process.command_args` (там бывает строка подключения) — топология нашей
    // инфраструктуры в общий приёмник. Ревью показало это на перехваченном OTLP-трафике.
    expect(boot.buildSdkConfig(deps, 'http://c:4318').resourceDetectors).toEqual([])
  })

  it('авто-инструментирование не подключается', () => {
    // Осознанно: точка входа рантайма — ESM, а патчить модули без хука `import-in-the-middle` OTel не
    // умеет; `pg` вдобавок вбандлен в `.output`. Подключение стоило бы 80 МБ ради нуля спанов.
    expect(boot.buildSdkConfig(deps, 'http://c:4318').instrumentations).toEqual([])
  })

  it('адрес коллектора подставляется в путь OTLP', () => {
    const cfg = boot.buildSdkConfig(deps, 'http://collector:4318')
    const exporter = (cfg.spanProcessors[1] as { exporter: { opts: { url: string } } }).exporter
    expect(exporter.opts.url).toBe('http://collector:4318/v1/traces')
  })
})

describe('образ и зависимости бутстрапа', () => {
  const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
  const dockerfile = read('../Dockerfile')

  it('бутстрап лежит РЯДОМ со своими node_modules, NODE_PATH не используется', () => {
    // ⚠️ `NODE_PATH` не работает для ESM — это документированное поведение Node, и ревью показало
    // последствие запуском: с заданным адресом коллектора контейнер не стартовал вовсе
    // (`ERR_MODULE_NOT_FOUND`), то есть переменная окружения выключала СЕРВИС, а не телеметрию.
    expect(dockerfile, 'ENV NODE_PATH — механизм, который для ESM не работает').not.toMatch(/ENV\s+NODE_PATH/)
    expect(dockerfile).toMatch(/--import=\/app\/otel\/instrument\.mjs/)
    // WORKDIR = /app, поэтому в COPY цель записана относительно: ./otel/node_modules
    expect(dockerfile).toMatch(/COPY .*\/otel\/node_modules \.\/otel\/node_modules/)
  })

  it('всё, что бутстрап импортирует, объявлено в preload-пакете', () => {
    // Иначе бутстрап падает при старте на отсутствующем модуле — а это единственный путь, где он
    // вообще что-то делает.
    const source = read('../otel.instrument.mjs')
    const preload = JSON.parse(read('../otel-preload-package.json')) as { dependencies: Record<string, string> }
    const imported = [...source.matchAll(/await import\('([^']+)'\)/g)].map((m) => m[1] as string)
    expect(imported.length).toBeGreaterThan(2)
    for (const pkg of imported) {
      expect(Object.keys(preload.dependencies), `${pkg} не объявлен в preload`).toContain(pkg)
    }
  })

  it('версия @opentelemetry/api совпадает с УСТАНОВЛЕННОЙ, а не с диапазоном', () => {
    // Сверка с диапазоном молчит ровно там, где поставлена: `pnpm update` меняет лок, не трогая
    // `^1.9.1`, версии расходятся — и регистрация SDK превращается в вечный no-op без ошибки.
    const installed = JSON.parse(read('../node_modules/@opentelemetry/api/package.json')) as { version: string }
    const preload = JSON.parse(read('../otel-preload-package.json')) as { dependencies: Record<string, string> }
    expect(preload.dependencies['@opentelemetry/api']).toBe(installed.version)
  })

  it('все версии preload запиннены точно', () => {
    const preload = JSON.parse(read('../otel-preload-package.json')) as { dependencies: Record<string, string> }
    for (const [name, version] of Object.entries(preload.dependencies)) {
      expect(version, `${name}: диапазон вместо точной версии`).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })
})
