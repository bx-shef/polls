import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bodyLimitStatus, MAX_REQUEST_BODY_BYTES } from '../src/api/body-limit'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

describe('bodyLimitStatus', () => {
  it('запрос без тела проходит без проверок', () => {
    // Обычный GET: ни длины, ни `Transfer-Encoding`. Это подавляющее большинство запросов, и они
    // обязаны стоить нам ровно ничего.
    expect(bodyLimitStatus({})).toBeNull()
    expect(bodyLimitStatus({ contentLength: undefined, transferEncoding: undefined })).toBeNull()
  })

  it('тело в пределах потолка проходит', () => {
    expect(bodyLimitStatus({ contentLength: '0' })).toBeNull()
    expect(bodyLimitStatus({ contentLength: '1024' })).toBeNull()
    expect(bodyLimitStatus({ contentLength: String(MAX_REQUEST_BODY_BYTES) })).toBeNull()
  })

  it('заявленная длина сверх потолка → 413', () => {
    expect(bodyLimitStatus({ contentLength: String(MAX_REQUEST_BODY_BYTES + 1) })?.status).toBe(413)
    expect(bodyLimitStatus({ contentLength: '2000000000' })?.status).toBe(413)
  })

  it('chunked без длины → 411, а не «ноль байт»', () => {
    // Ровно тот обход, который был у поимённых капов: `Number(undefined ?? 0)` даёт `0`, и тело
    // без заявленной длины проходило как нулевое — то есть `readBody` буферизовал его целиком.
    expect(bodyLimitStatus({ transferEncoding: 'chunked' })?.status).toBe(411)
    expect(bodyLimitStatus({ transferEncoding: 'gzip, chunked' })?.status).toBe(411)
  })

  it('длина в форме, которой нельзя верить, → 411, а не догадка', () => {
    // `Number()` проглотил бы каждую из этих строк и выдал число, разошедшееся с реальным телом.
    // Расхождение «заявлено одно, приедет другое» — почва для подмешивания второго запроса в поток,
    // поэтому отказываем, а не угадываем.
    for (const raw of ['1e9', '0x10', '-1', '1.5', '', ' ', '10, 20', '12abc', '+7']) {
      expect(bodyLimitStatus({ contentLength: raw })?.status, JSON.stringify(raw)).toBe(411)
    }
  })

  it('потолок настраивается — роут может быть строже общего', () => {
    expect(bodyLimitStatus({ contentLength: '9000', limit: 8 * 1024 })?.status).toBe(413)
    expect(bodyLimitStatus({ contentLength: '8000', limit: 8 * 1024 })).toBeNull()
  })

  it('у отказа есть текст на русском — его увидит человек', () => {
    // Роуты этого проекта отдают `{ ok:false, error }`, и текст пишет сервер (см. ~core/client).
    for (const v of [bodyLimitStatus({ contentLength: '99999999' }), bodyLimitStatus({ transferEncoding: 'chunked' })]) {
      expect(v?.error).toMatch(/[а-яё]/i)
      expect(v?.error.length).toBeGreaterThan(10)
    }
  })
})

/**
 * Гарды. Смысл бэкстопа в том, что он действует БЕЗ участия автора роута, — а это свойство легко
 * потерять одной строчкой, и потеря будет невидимой: роуты продолжат отвечать как раньше.
 */
describe('бэкстоп применяется ко всему', () => {
  const middleware = readFileSync(join(ROOT, 'server/middleware/body-limit.ts'), 'utf8')

  it('middleware зовёт ядровую проверку', () => {
    expect(middleware).toContain('bodyLimitStatus(')
    expect(middleware).toContain('~core/api/body-limit')
  })

  it('middleware НЕ отбирает маршруты — иначе он перестаёт быть последней линией', () => {
    // Любая фильтрация по пути возвращает нас к поимённой защите: забытый роут снова окажется
    // снаружи, и выглядеть это будет ровно как «всё под охраной».
    const code = stripComments(middleware)
    for (const marker of ['event.path', 'startsWith(', 'includes(', 'getRequestURL']) {
      expect(code.includes(marker), `фильтрация по маршруту: ${marker}`).toBe(false)
    }
  })

  it('ни один роут не объявляет кап БОЛЬШЕ общего потолка', () => {
    // Кап роута сверх бэкстопа — обещание, которого роут выполнить не может: запрос отсечётся раньше,
    // чем дойдёт до него, и разбираться будут с роутом, а не с этим файлом.
    const routes = listFiles(join(ROOT, 'server/api'))
    expect(routes.length).toBeGreaterThan(8)
    for (const f of routes) {
      for (const m of readFileSync(f, 'utf8').matchAll(/MAX_BODY_BYTES\s*=\s*([\d\s*]+)/g)) {
        const value = evalByteExpr(m[1] ?? '')
        expect(value, `${f}: кап ${m[1]} больше общего потолка`).toBeLessThanOrEqual(MAX_REQUEST_BODY_BYTES)
      }
    }
  })
})

/** `64 * 1024` → 65536. Только цифры, пробелы и `*` — ничего исполняемого из файла сюда не попадает. */
function evalByteExpr(expr: string): number {
  return expr
    .split('*')
    .map((p) => Number(p.trim()))
    .reduce((a, b) => a * b, 1)
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []
  )
}
