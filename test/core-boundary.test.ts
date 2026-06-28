import { describe, expect, it } from 'vitest'
import {
  findBoundaryViolations,
  ALLOWED_CORE_SEGMENTS,
  SERVER_ONLY_CORE_SEGMENTS
} from '../scripts/check-core-boundary'

const f = (content: string, path = 'app/x.vue') => [{ path, content }]

describe('findBoundaryViolations — граница ~core (#36)', () => {
  it('разрешённые сегменты (client/domain) — без нарушений', () => {
    const src = [
      "import { SurveyFill } from '~core/client/survey-fill'",
      "import type { PublicVersion } from '~core/domain/schema'",
      "import type { BreakdownRow } from '~core/domain/aggregate'"
    ].join('\n')
    expect(findBoundaryViolations(f(src))).toEqual([])
  })

  it('server-only сегменты — нарушение для каждого', () => {
    for (const seg of SERVER_ONLY_CORE_SEGMENTS) {
      const v = findBoundaryViolations(f(`import { x } from '~core/${seg}/y'`))
      expect(v).toHaveLength(1)
      expect(v[0]?.specifier).toBe(`~core/${seg}/y`)
      expect(v[0]?.reason).toContain('server-only')
    }
  })

  it('голый ~core (тянет index) — нарушение', () => {
    const v = findBoundaryViolations(f("import x from '~core'"))
    expect(v).toHaveLength(1)
    expect(v[0]?.reason).toContain('index')
  })

  it('dynamic import server-only — нарушение', () => {
    const v = findBoundaryViolations(f("const m = await import('~core/store/pg')"))
    expect(v).toHaveLength(1)
    expect(v[0]?.specifier).toBe('~core/store/pg')
  })

  it('обход альяса прямым относительным путём в server-only — нарушение', () => {
    const v = findBoundaryViolations(f("import { TokenCipher } from '../../src/bitrix24/crypto'"))
    expect(v).toHaveLength(1)
    expect(v[0]?.reason).toContain('в обход границы')
  })

  it('строки/комментарии с ~core (не import/from) — НЕ нарушение', () => {
    const src = [
      '// Импорт из ядра — только ~core/client и ~core/domain (см. правило)',
      "const note = 'use ~core/store on server only'",
      "import type { Q } from '~core/domain/schema'"
    ].join('\n')
    expect(findBoundaryViolations(f(src))).toEqual([])
  })

  it('строка-комментарий с настоящим from/import — НЕ нарушение (skip комментариев)', () => {
    const src = [
      "// не делай: import { x } from '~core/store/pg'",
      "  * пример в JSDoc: import('~core/api/handlers')",
      "import type { Q } from '~core/domain/schema'"
    ].join('\n')
    expect(findBoundaryViolations(f(src))).toEqual([])
  })

  it('require server-only — нарушение', () => {
    const v = findBoundaryViolations(f("const c = require('~core/bitrix24/crypto')"))
    expect(v).toHaveLength(1)
    expect(v[0]?.specifier).toBe('~core/bitrix24/crypto')
  })

  it('import type из server-only — тоже нарушение (тип утечёт через бандлер)', () => {
    const v = findBoundaryViolations(f("import type { PgStore } from '~core/store/pg'"))
    expect(v).toHaveLength(1)
    expect(v[0]?.reason).toContain('server-only')
  })

  it('~core/index — нарушение с сообщением про index', () => {
    const v = findBoundaryViolations(f("import x from '~core/index'"))
    expect(v).toHaveLength(1)
    expect(v[0]?.reason).toContain('index')
  })

  it('префиксная коллизия ~core/client-foo — нарушение (это не сегмент client)', () => {
    const v = findBoundaryViolations(f("import x from '~core/client-foo/y'"))
    expect(v).toHaveLength(1)
  })

  it('сторонний npm-пакет с src/api в имени — НЕ нарушение (только относительные пути)', () => {
    const v = findBoundaryViolations(f("import { u } from '@scope/src/api/utils'"))
    expect(v).toEqual([])
  })

  it('сторонние/относительные импорты вне ядра — игнорируются', () => {
    const src = [
      "import { ref } from 'vue'",
      "import Foo from './Foo.vue'",
      "import { bar } from '../utils'"
    ].join('\n')
    expect(findBoundaryViolations(f(src))).toEqual([])
  })

  it('номер строки и путь файла в нарушении корректны', () => {
    const src = "import { ref } from 'vue'\nimport { db } from '~core/store/pg'"
    const v = findBoundaryViolations([{ path: 'app/pages/d.vue', content: src }])
    expect(v[0]).toMatchObject({ path: 'app/pages/d.vue', line: 2, specifier: '~core/store/pg' })
  })

  it('инвариант: client и domain — единственные разрешённые сегменты', () => {
    expect([...ALLOWED_CORE_SEGMENTS].sort()).toEqual(['client', 'domain'])
  })
})
