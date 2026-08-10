import { describe, it, expect, beforeAll } from 'vitest'
import { spawnSync } from 'node:child_process'
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
    metricReaders: unknown[]
    logRecordProcessors: unknown[]
  }
  isAttributeKept: (key: string) => boolean
  isValueKept: (value: unknown) => boolean
  isEntryKept: (key: string, value: unknown) => boolean
  redactingExporter: (inner: unknown) => { export: (spans: unknown[], cb: (r: unknown) => void) => void }
  normalizeEndpoint: (raw: unknown) => string
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

  it('экспортёр в конвейере ОБЁРНУТ вычисткой', () => {
    // ⚠️ Мутация «убрать `redactingExporter(...)` из конвейера» проходила мимо тестов: сам механизм был
    // покрыт, а его ПОДКЛЮЧЕНИЕ — нет. Это ровно тот класс дыры, из-за которого в этом PR уже дважды
    // переделывались гарды.
    const cfg = boot.buildSdkConfig(deps, 'http://c:4318')
    const exporter = (cfg.spanProcessors[1] as { exporter: unknown }).exporter
    expect(exporter, 'в BatchSpanProcessor уехал сырой OTLP-экспортёр без вычистки')
      .not.toBeInstanceOf(deps.OTLPTraceExporter)
    // И это действительно наша обёртка: она фильтрует.
    const sent: unknown[][] = []
    const wrapped = boot.redactingExporter({
      export: (spans: unknown[], cb: (r: unknown) => void) => { sent.push(spans); cb({ code: 0 }) },
      shutdown: () => Promise.resolve()
    })
    expect(Object.keys(exporter as object).sort()).toEqual(Object.keys(wrapped).sort())
  })

  it('детекторы ресурса ОТКЛЮЧЕНЫ', () => {
    // По умолчанию NodeSDK включает host/process-детекторы, и в каждый спан уезжают `host.name`,
    // `process.owner`, `process.command_args` (там бывает строка подключения) — топология нашей
    // инфраструктуры в общий приёмник. Ревью показало это на перехваченном OTLP-трафике.
    expect(boot.buildSdkConfig(deps, 'http://c:4318').resourceDetectors).toEqual([])
  })

  it('каналы метрик и логов ОТКЛЮЧЕНЫ явно, пустым списком', () => {
    // ⚠️ Не косметика. `NodeSDK`, не получив `metricReaders`/`logRecordProcessors`, берёт их из
    // окружения и при пустом наборе экспортёров дописывает `otlp` САМ — на тот же адрес. Ревью
    // показало на живом приёмнике POST'ы `/v1/metrics` и `/v1/logs` с `db.statement`, `url.path` с
    // ключом опроса и телом лог-записи со строкой подключения: мимо процессора И мимо вето экспортёра.
    // Провайдеры регистрируются глобально, поэтому «мы этим не пользуемся» защитой не является.
    const cfg = boot.buildSdkConfig(deps, 'http://c:4318')
    expect(cfg.metricReaders, 'канал метрик поднимется из env и уедет мимо вычистки').toEqual([])
    expect(cfg.logRecordProcessors, 'канал логов поднимется из env и уедет мимо вычистки').toEqual([])
  })

  it('авто-инструментирование не подключается', () => {
    // Осознанно: точка входа рантайма — ESM, а патчить модули без хука `import-in-the-middle` OTel не
    // умеет; `pg` вдобавок вбандлен в `.output`. Подключение стоило бы 80 МБ ради нуля спанов.
    expect(boot.buildSdkConfig(deps, 'http://c:4318').instrumentations).toEqual([])
  })

  it('адрес коллектора подставляется в путь OTLP и нормализуется', () => {
    // Экспортёр обёрнут `redactingExporter`, поэтому URL ловим на конструкторе, а не через обёртку.
    const urls: string[] = []
    const spy = {
      ...deps,
      OTLPTraceExporter: class { constructor(opts: { url: string }) { urls.push(opts.url) } }
    }
    boot.buildSdkConfig(spy, 'http://collector:4318')
    boot.buildSdkConfig(spy, 'http://collector:4318/')
    expect(urls).toEqual(['http://collector:4318/v1/traces', 'http://collector:4318/v1/traces'])
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

  /**
   * Лок-файл preload — это supply-chain-граница, и она строже, чем у бандла приложения: этот код
   * грузится через `--import` ДО приложения, в том же процессе и с теми же правами. Прямых
   * зависимостей четыре, а приезжает 71 пакет — без лока 67 транзитивных резолвились бы заново на
   * каждой сборке образа. Тот же довод, по которому сторонние GitHub-actions запиннены на commit-SHA.
   */
  describe('лок-файл preload', () => {
    const lock = JSON.parse(read('../otel-preload-package-lock.json')) as {
      lockfileVersion: number
      packages: Record<string, { version?: string, resolved?: string, integrity?: string, link?: boolean }>
    }

    it('у каждого пакета есть integrity и resolved', () => {
      const entries = Object.entries(lock.packages).filter(([path, meta]) => path && !meta.link)
      expect(entries.length, 'лок-файл пуст — сборка резолвила бы дерево заново').toBeGreaterThan(50)
      for (const [path, meta] of entries) {
        expect(meta.integrity, `${path}: без integrity подмена содержимого не заметна`).toBeTruthy()
        expect(meta.resolved, `${path}: без resolved источник не зафиксирован`).toBeTruthy()
      }
    })

    it('версии прямых зависимостей совпадают с манифестом', () => {
      // Расхождение молчаливо: `npm ci` поставил бы версию из лока, а сверка версии `@opentelemetry/api`
      // с бандлом приложения смотрит в манифест — и «совпадает» превратилось бы в неправду.
      const preload = JSON.parse(read('../otel-preload-package.json')) as { dependencies: Record<string, string> }
      for (const [name, version] of Object.entries(preload.dependencies)) {
        expect(lock.packages[`node_modules/${name}`]?.version, `${name}: лок и манифест разошлись`).toBe(version)
      }
    })

    it('образ ставит preload по локу и БЕЗ install-скриптов', () => {
      // `protobufjs` в дереве несёт `postinstall`, и он выполнялся бы прямо в сборке образа — ради
      // gRPC/proto-экспортёров, которых бутстрап не импортирует вовсе.
      expect(dockerfile).toMatch(/npm ci --omit=dev --ignore-scripts/)
      expect(dockerfile, 'npm install резолвил бы транзитивные заново на каждой сборке')
        .not.toMatch(/cd \/otel && npm install/)
      expect(dockerfile).toMatch(/COPY otel-preload-package-lock\.json \/otel\/package-lock\.json/)
    })
  })
})

describe('экспортёр — ПОСЛЕДНЯЯ линия, и единственная, где вето возможно', () => {
  const collect = () => {
    const sent: unknown[][] = []
    const inner = {
      export: (spans: unknown[], cb: (r: unknown) => void) => { sent.push(spans); cb({ code: 0 }) },
      shutdown: () => Promise.resolve(),
      forceFlush: () => Promise.resolve()
    }
    return { sent, exporter: boot.redactingExporter(inner) }
  }

  it('спан с уцелевшей утечкой НЕ отправляется', () => {
    // ⚠️ Это не дубль процессора. `onEnd` не умеет наложить вето: `MultiSpanProcessor` зовёт его у
    // всех процессоров независимо от исхода предыдущего. Ревью показало на настоящем `SpanImpl`: при
    // замороженных атрибутах `delete` бросает, аварийная ветка бросает на том же ключе — и спан
    // уезжает ПОЛНОСТЬЮ нередактированным. Здесь отказ возможен, и он происходит.
    const { sent, exporter } = collect()
    const frozen = Object.freeze({
      'http.route': '/s/:key',
      'url.path': '/s/СЕКРЕТНЫЙ-КЛЮЧ',
      'db.query.text': "INSERT INTO response_answer (text) VALUES ('всё ужасно')"
    })
    const span = { attributes: frozen, events: [], status: { code: 2 } }
    // Процессор на замороженном объекте бессилен — проверяем, что это ловит экспортёр.
    new boot.RedactingSpanProcessor().onEnd(span)
    exporter.export([span], () => {})
    expect(sent.flat(), 'спан с утечкой уехал в коллектор').toEqual([])
  })

  it('спан с уцелевшим событием или текстом статуса НЕ отправляется', () => {
    const { sent, exporter } = collect()
    exporter.export([
      { attributes: { 'http.route': '/s/:key' }, events: [{ name: 'exception' }], status: { code: 2 } },
      { attributes: { 'http.route': '/s/:key' }, events: [], status: { code: 2, message: 'DSN' } }
    ], () => {})
    expect(sent.flat()).toEqual([])
  })

  it('чистый спан отправляется', () => {
    const { sent, exporter } = collect()
    const clean = { attributes: { 'b24.method': 'crm.deal.get', 'portal.hash': 'deadbeefdeadbeef' }, events: [], status: { code: 1 } }
    exporter.export([clean], () => {})
    expect(sent.flat()).toEqual([clean])
  })

  it('сбой самой проверки → не отправляем ничего', () => {
    const { sent, exporter } = collect()
    const nasty = { get attributes(): never { throw new Error('спан сломан') } }
    exporter.export([nasty], () => {})
    expect(sent.flat()).toEqual([])
  })
})

describe('чужой контекст не извлекается', () => {
  const deps = {
    resourceFromAttributes: (a: unknown) => ({ resource: a }),
    BatchSpanProcessor: class { constructor(readonly exporter: unknown) {} },
    OTLPTraceExporter: class { constructor(readonly opts: { url: string }) {} }
  }

  it('пропагатор ничего не извлекает и ничего не внедряет', () => {
    // Публичные маршруты принимает неаутентифицированный респондент. Ревью показало на живом экспорте:
    // `tracestate` уезжал дословно (до 32 записей по 256 символов от отправителя), `traceparent` с
    // флагом `00` глушил трассировку целиком, а `baggage` переинъектировался в исходящие к порталу.
    const cfg = boot.buildSdkConfig(deps, 'http://c:4318') as unknown as {
      textMapPropagator: { extract: (c: unknown) => unknown, fields: () => string[], inject: () => void }
    }
    const p = cfg.textMapPropagator
    expect(p.fields()).toEqual([])
    const ctx = { исходный: true }
    expect(p.extract(ctx), 'чужой контекст просочился').toBe(ctx)
    expect(() => p.inject()).not.toThrow()
  })
})

describe('адрес коллектора нормализуется', () => {
  it('хвостовой слэш не даёт //v1/traces', () => {
    expect(boot.normalizeEndpoint('http://c:4318/')).toBe('http://c:4318')
    expect(boot.normalizeEndpoint('http://c:4318///')).toBe('http://c:4318')
    expect(boot.normalizeEndpoint('  http://c:4318  ')).toBe('http://c:4318')
  })

  it('уже приписанный сигнальный суффикс не удваивается', () => {
    // В доках OTel сигнальная переменная идёт С путём (`..._TRACES_ENDPOINT=…/v1/traces`) — копипаста
    // в общую `OTEL_EXPORTER_OTLP_ENDPOINT` давала `/v1/traces/v1/traces` и тихо теряла всю телеметрию.
    expect(boot.normalizeEndpoint('https://collector:4318/v1/traces')).toBe('https://collector:4318')
    expect(boot.normalizeEndpoint('https://collector:4318/v1/metrics/')).toBe('https://collector:4318')
  })

  it('query и фрагмент отбрасываются', () => {
    expect(boot.normalizeEndpoint('http://c:4318?x=1')).toBe('http://c:4318')
    expect(boot.normalizeEndpoint('http://host/#')).toBe('http://host')
  })

  it('префикс пути СОХРАНЯЕТСЯ — коллектор за подпутём это рабочая раскладка', () => {
    expect(boot.normalizeEndpoint('https://obs.example/otel/')).toBe('https://obs.example/otel')
    expect(boot.normalizeEndpoint('https://obs.example/otel/v1/traces')).toBe('https://obs.example/otel')
  })

  it('невалидный адрес не бросает — бутстрап не имеет права падать', () => {
    expect(() => boot.normalizeEndpoint('не-адрес')).not.toThrow()
    expect(boot.normalizeEndpoint(undefined)).toBe('')
  })

  it('адрес без схемы не превращается в «collector://4318»', () => {
    // ⚠️ `new URL('collector:4318')` разбирается УСПЕШНО, с протоколом `collector:` — и наивная сборка
    // из частей давала `collector://4318/v1/traces`, то есть молча мёртвый конвейер. Отдаём строку как
    // есть: экспортёр упадёт на неверном URL, это поймает fail-open и назовёт проблему в логе.
    expect(boot.normalizeEndpoint('collector:4318')).toBe('collector:4318')
    expect(boot.normalizeEndpoint('file:///etc/passwd')).toBe('file:///etc/passwd')
  })
})

/**
 * Вторая половина решения — ФОРМА ЗНАЧЕНИЯ. Проверка одного имени пропускала носителей данных под
 * разрешёнными именами; ревью показало это на живом OTLP-захвате.
 */
describe('значение атрибута проверяется, а не только имя', () => {
  it('массив под разрешённым именем не проходит', () => {
    // Дословный захват ревью: `http.route: ['/s/SECRETKEY-IN-ARRAY', '+375291234567']` уехал массивом.
    expect(boot.isValueKept(['/s/SECRETKEY-IN-ARRAY', '+375291234567'])).toBe(false)
    expect(boot.isEntryKept('http.route', ['/s/SECRETKEY-IN-ARRAY'])).toBe(false)
    expect(boot.isEntryKept('http.route', '/s/:key')).toBe(true)
  })

  it('наш собственный префикс не даёт свободного текста', () => {
    // `portal.hash`/`b24.method` заполняет `pickSafeAttributes` (имя И форма), но ЧУЖОЙ спан может
    // поставить те же имена — на них у бутстрапа своей проверки формы не было вовсе.
    expect(boot.isEntryKept('portal.hash', 'PORTALLEAK-акме.bitrix24.by')).toBe(false)
    expect(boot.isEntryKept('b24.method', 'LEAK:ивановcompany')).toBe(false)
    expect(boot.isEntryKept('portal.hash', 'deadbeefdeadbeef')).toBe(true)
    expect(boot.isEntryKept('b24.method', 'crm.deal.get')).toBe(true)
  })

  it('кириллица, управляющие/bidi-символы и длинные строки выбрасываются', () => {
    expect(boot.isValueKept('всё ужасно')).toBe(false)
    expect(boot.isValueKept('ok\u0000drop')).toBe(false)
    expect(boot.isValueKept('ok\u202edrop')).toBe(false)
    expect(boot.isValueKept('x'.repeat(129))).toBe(false)
    expect(boot.isValueKept('x'.repeat(128))).toBe(true)
  })

  it('скаляры проходят, объекты и не-числа — нет', () => {
    expect(boot.isValueKept(200)).toBe(true)
    expect(boot.isValueKept(false)).toBe(true)
    expect(boot.isValueKept('')).toBe(true)
    expect(boot.isValueKept(Number.NaN)).toBe(false)
    expect(boot.isValueKept(Infinity)).toBe(false)
    expect(boot.isValueKept({ вложенный: 'объект' })).toBe(false)
    expect(boot.isValueKept(null)).toBe(false)
    expect(boot.isValueKept(undefined)).toBe(false)
  })

  it('процессор и вето экспортёра выбрасывают значение, а не только имя', () => {
    const span = {
      attributes: { 'http.route': ['/s/КЛЮЧ-В-МАССИВЕ'], 'db.system': 'postgresql' },
      events: [], status: { code: 1 }
    }
    new boot.RedactingSpanProcessor().onEnd(span)
    expect(Object.keys(span.attributes)).toEqual(['db.system'])

    const sent: unknown[][] = []
    const exporter = boot.redactingExporter({
      export: (spans: unknown[], cb: (r: unknown) => void) => { sent.push(spans); cb({ code: 0 }) },
      shutdown: () => Promise.resolve()
    })
    const frozen = Object.freeze({ 'http.route': ['/s/КЛЮЧ-В-МАССИВЕ'] })
    exporter.export([{ attributes: frozen, events: [], status: { code: 1 } }], () => {})
    expect(sent.flat(), 'значение-массив под разрешённым именем уехало в коллектор').toEqual([])
  })
})

/**
 * Связи (`links`) — третий носитель, который до правки шёл мимо ОБОИХ слоёв: у каждой связи свои
 * `attributes`, а `otlp-transformer` дополнительно сериализует `link.context.traceState`. Ревью
 * показало на настоящем SDK, что `url.full` с токеном и текст SQL внутри `links[]` доезжают до
 * приёмника дословно.
 */
describe('связи спана (links)', () => {
  const linky = () => ({
    attributes: { 'http.route': '/s/:key' },
    events: [],
    links: [{
      context: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceState: { serialize: () => 'leak=x' } },
      attributes: { 'url.full': 'https://acme.bitrix24.by/rest/?auth=ТОКЕН', 'db.statement': 'SELECT LINKLEAK' }
    }],
    status: { code: 1 }
  })

  it('процессор сносит связи целиком', () => {
    const span = linky()
    new boot.RedactingSpanProcessor().onEnd(span)
    expect(span.links).toHaveLength(0)
    expect(JSON.stringify(span)).not.toContain('LINKLEAK')
  })

  it('уцелевшая связь — вето экспортёра', () => {
    const sent: unknown[][] = []
    const exporter = boot.redactingExporter({
      export: (spans: unknown[], cb: (r: unknown) => void) => { sent.push(spans); cb({ code: 0 }) },
      shutdown: () => Promise.resolve()
    })
    const span = linky()
    Object.freeze(span.links)
    exporter.export([span], () => {})
    expect(sent.flat(), 'связь с токеном и SQL уехала в коллектор').toEqual([])
  })
})

describe('события проверяются по length, а не по Array.isArray', () => {
  it('массивоподобные события не пролезают', () => {
    // Сериализатор OTLP ходит через `.map`, поэтому массивоподобный объект он выгрузит, а
    // `Array.isArray` его пропустит — ревью довело такой `exception.message` до приёмника.
    const arrayLike = { 0: { name: 'exception', attributes: { 'exception.message': 'OBJEVENTLEAK' } }, length: 1 }
    const span = { attributes: { 'db.system': 'postgresql' }, events: arrayLike, status: { code: 1 } }
    new boot.RedactingSpanProcessor().onEnd(span)
    expect(span.events.length).toBe(0)

    const sent: unknown[][] = []
    const exporter = boot.redactingExporter({
      export: (spans: unknown[], cb: (r: unknown) => void) => { sent.push(spans); cb({ code: 0 }) },
      shutdown: () => Promise.resolve()
    })
    exporter.export([{ attributes: {}, events: { length: 1 }, status: { code: 1 } }], () => {})
    expect(sent.flat()).toEqual([])
  })
})

describe('имена атрибутов соответствуют запиннённым версиям semconv', () => {
  it('обе формы имени — старая и новая', () => {
    // Инструментации в переходе со старого semconv на новый. Ревью показало цену однобокости:
    // `instrumentation-pg` в запиннённой версии НЕ выставляет `db.statement` вовсе — SQL приезжает в
    // `db.query.text`, и тест на `db.statement` проверял имя, которого не бывает.
    for (const key of ['db.system', 'db.system.name', 'db.operation', 'db.operation.name']) {
      expect(boot.isAttributeKept(key), key).toBe(true)
    }
    // Новые имена носителей данных — по-прежнему не проходят.
    for (const key of ['db.query.text', 'db.query.parameter.0', 'db.namespace',
      'network.peer.address', 'network.peer.port', 'server.port', 'url.template',
      'http.request.header.x-forwarded-for', 'user_agent.synthetic.type']) {
      expect(boot.isAttributeKept(key), `${key} остался бы в спане`).toBe(false)
    }
  })
})

/**
 * Закрытие класса «список расширили незаметно».
 *
 * Проверки через `isAttributeKept` по именам — это ПЕРЕЧИСЛЕНИЕ известных утечек, то есть денилист:
 * любое имя вне перечисления проходит. Ревью показало это тремя мутантами, все зелёные: добавление
 * `net.sock.peer.addr` (старое имя IP пира) в разрешённые, карв-аут внутри `onEnd` и лишний префикс
 * `survey.` в списке «наших». Поэтому пиннем САМИ СПИСКИ, а не выборку имён.
 */
describe('белый список не расширяется незаметно', () => {
  it('состав списков запиннен дословно', () => {
    expect([...boot.SAFE_FOREIGN_ATTRIBUTES]).toEqual([
      'http.request.method', 'http.method', 'http.response.status_code', 'http.status_code',
      'url.scheme', 'http.route', 'db.system', 'db.system.name', 'db.operation', 'db.operation.name',
      'messaging.system'
    ])
    expect([...boot.OWN_ATTRIBUTE_PREFIXES]).toEqual(['portal.', 'b24.', 'error_kind', 'stage'])
  })

  it('процессор решает ТЕМ ЖЕ предикатом, что и экспортёр', () => {
    // Иначе их можно рассогласовать: карв-аут внутри `onEnd` (`&& key !== 'db.query.text'`) не ловился
    // ничем, потому что фикстура таких ключей не содержала, а экспортёр ходил через нетронутый предикат.
    const keys = [
      ...boot.SAFE_FOREIGN_ATTRIBUTES, 'portal.hash', 'b24.method', 'error_kind', 'stage',
      'db.query.text', 'db.query.parameter.0', 'db.namespace', 'net.sock.peer.addr',
      'url.path', 'url.full', 'client.address', 'user_agent.original', 'survey.key', 'anything.else'
    ]
    const span = { attributes: Object.fromEntries(keys.map((k) => [k, 'x'])), events: [], status: { code: 1 } }
    new boot.RedactingSpanProcessor().onEnd(span)
    for (const key of Object.keys(span.attributes)) {
      expect(boot.isAttributeKept(key), `${key} оставлен процессором, но не разрешён предикатом`).toBe(true)
    }
    for (const key of keys.filter((k) => boot.isAttributeKept(k))) {
      expect(Object.keys(span.attributes), `${key} разрешён, но выброшен процессором`).toContain(key)
    }
  })
})

describe('обёртка экспортёра проверяется ПОВЕДЕНИЕМ, а не формой', () => {
  it('сквозная обёртка с теми же методами не проходит', () => {
    // Прежний гард сравнивал набор ключей объекта — любой объект с export/shutdown/forceFlush его
    // удовлетворял, включая прозрачную обёртку без фильтрации.
    const sent: unknown[][] = []
    const deps = {
      resourceFromAttributes: (a: unknown) => ({ resource: a }),
      BatchSpanProcessor: class { constructor(readonly exporter: unknown) {} },
      OTLPTraceExporter: class {
        export(spans: unknown[], cb: (r: unknown) => void) { sent.push(spans); cb({ code: 0 }) }
        shutdown() { return Promise.resolve() }
        forceFlush() { return Promise.resolve() }
      }
    }
    const cfg = boot.buildSdkConfig(deps, 'http://c:4318')
    const exporter = (cfg.spanProcessors[1] as { exporter: { export: (s: unknown[], cb: (r: unknown) => void) => void } }).exporter
    const dirty = { attributes: { 'url.path': '/s/СЕКРЕТНЫЙ-КЛЮЧ' }, events: [], status: { code: 2 } }
    exporter.export([dirty], () => {})
    expect(sent.flat(), 'грязный спан дошёл до настоящего экспортёра').toEqual([])
  })
})

describe('контракт экспортёра перед BatchSpanProcessor', () => {
  const wrap = () => {
    const sent: unknown[][] = []
    const inner = {
      export: (spans: unknown[], cb: (r: unknown) => void) => { sent.push(spans); cb({ code: 0 }) },
      shutdown: () => Promise.resolve()
    }
    return { sent, exporter: boot.redactingExporter(inner) }
  }

  it('колбэк вызывается РОВНО раз с успехом даже при пустой выборке', () => {
    // Иначе `BatchSpanProcessor` подвиснет на флаше, а код ошибки заставит его считать экспорт
    // провалившимся и копить спаны.
    const { sent, exporter } = wrap()
    const results: unknown[] = []
    exporter.export([{ attributes: { 'url.path': '/s/ключ' }, events: [], status: {} }], (r) => results.push(r))
    expect(results).toEqual([{ code: 0 }])
    expect(sent.flat()).toEqual([])
  })

  it('forceFlush работает, даже если у внутреннего экспортёра его нет', async () => {
    const { exporter } = wrap()
    await expect((exporter as unknown as { forceFlush: () => Promise<void> }).forceFlush()).resolves.toBeUndefined()
    await expect((exporter as unknown as { shutdown: () => Promise<void> }).shutdown()).resolves.toBeUndefined()
  })
})

describe('ресурс спана', () => {
  const deps = {
    resourceFromAttributes: (a: unknown) => ({ attrs: a }),
    BatchSpanProcessor: class { constructor(readonly exporter: unknown) {} },
    OTLPTraceExporter: class { constructor(readonly opts: { url: string }) {} }
  }

  it('в ресурс идёт ТОЛЬКО имя сервиса', () => {
    // Мутанты «подставить HOSTNAME в service.name» и «убрать resource целиком» проходили незамеченными,
    // а ресурс уезжает в КАЖДОМ батче.
    delete process.env.OTEL_SERVICE_NAME
    const cfg = boot.buildSdkConfig(deps, 'http://c:4318') as unknown as { resource: { attrs: Record<string, unknown> } }
    expect(cfg.resource.attrs).toEqual({ 'service.name': 'polls' })
    process.env.OTEL_SERVICE_NAME = 'опросы'
    const named = boot.buildSdkConfig(deps, 'http://c:4318') as unknown as { resource: { attrs: Record<string, unknown> } }
    expect(named.resource.attrs).toEqual({ 'service.name': 'опросы' })
    delete process.env.OTEL_SERVICE_NAME
  })
})

/**
 * Верхний уровень бутстрапа — гейт «по умолчанию выключено» и fail-open — исполняется настоящим Node.
 *
 * Ни один тест выше его не трогает: импорт модуля в vitest идёт с СНЯТОЙ переменной окружения, то есть
 * ветка `if (endpoint)` не выполняется вовсе. А это два заголовочных инварианта файла: без адреса
 * коллектора не делаем ничего, и любой сбой телеметрии НЕ роняет процесс — падение было бы в preload,
 * до нашего логгера, и в журнале остался бы только чужой стектрейс.
 */
describe('бутстрап под --import: выключен по умолчанию и fail-open', () => {
  const run = (env: Record<string, string>) => spawnSync(
    process.execPath,
    ['--import', './otel.instrument.mjs', '-e', 'console.log("ЖИВ")'],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', env: { ...process.env, ...env } }
  )

  it('без адреса коллектора процесс работает штатно', () => {
    const r = run({ OTEL_EXPORTER_OTLP_ENDPOINT: '' })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('ЖИВ')
  })

  it('с адресом, но БЕЗ установленного SDK процесс всё равно работает', () => {
    // Ровно тот сценарий, что ревью нашло запуском в раскладке образа: без fail-open переменная
    // окружения выключала не телеметрию, а СЕРВИС — и выставить её можно без PR, без CI и без ревью.
    const r = run({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' })
    expect(r.status, `процесс упал: ${r.stderr}`).toBe(0)
    expect(r.stdout).toContain('ЖИВ')
    expect(r.stderr, 'сбой телеметрии должен быть назван в логе').toContain('[otel]')
  })
})
