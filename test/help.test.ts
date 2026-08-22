import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  HELP_TOPICS, helpTopic, buildLlmsTxt, buildLlmsFullTxt, topicMarkdown
} from '../src/client/help'

/**
 * Справка — единый реестр на три потребителя (слайдер, /docs, llms.txt).
 *
 * ⚠️ Ключ темы в `<HelpButton topic="...">` — строка: опечатка не падает ни компилятором, ни на
 * рантайме (слайдер честно скажет «раздел не найден», но человеку от этого не легче). Поэтому связь
 * «кнопка → тема» сверяется здесь, по исходникам экранов.
 */
describe('реестр справки', () => {
  it('ключи уникальны и непусты, у каждой темы есть содержимое', () => {
    const keys = HELP_TOPICS.map((t) => t.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const t of HELP_TOPICS) {
      expect(t.key).toMatch(/^[a-z][a-z-]*$/)
      expect(t.title.length).toBeGreaterThan(3)
      expect(t.summary.length).toBeGreaterThan(10)
      expect(t.sections.length).toBeGreaterThan(0)
      const text = t.sections.flatMap((s) => [...(s.paragraphs ?? []), ...(s.bullets ?? [])])
      expect(text.length, `${t.key}: тема без текста`).toBeGreaterThan(0)
    }
  })

  it('helpTopic находит существующее и честно отдаёт undefined на чужом', () => {
    expect(helpTopic('dashboard')?.title).toBeTruthy()
    expect(helpTopic('нет-такого')).toBeUndefined()
  })

  it('каждая кнопка справки в интерфейсе ссылается на СУЩЕСТВУЮЩУЮ тему', () => {
    const dir = resolve(process.cwd(), 'app')
    const vues: string[] = []
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name))
        else if (e.name.endsWith('.vue')) vues.push(join(d, e.name))
      }
    }
    walk(dir)
    const known = new Set(HELP_TOPICS.map((t) => t.key))
    for (const f of vues) {
      for (const m of readFileSync(f, 'utf8').matchAll(/<HelpButton\s+topic="([^"]+)"/g)) {
        expect(known.has(m[1]!), `${f}: тема «${m[1]}» не существует`).toBe(true)
      }
    }
    // ⚠️ Экраны перечислены ПОИМЁННО, а не числом: «кнопок ≥ 3» пропускало снятие кнопки с одного
    // экрана, пока их хватало на других, — то есть гард считал наличие фичи, а не её расстановку.
    const MUST_HAVE: Record<string, string> = {
      'app/pages/admin/surveys/index.vue': 'surveys',
      'app/pages/admin/surveys/[key].vue': 'surveys',
      'app/pages/d/[key].vue': 'dashboard',
      'app/pages/b24/deal-widget.vue': 'launch'
    }
    for (const [file, topic] of Object.entries(MUST_HAVE)) {
      const src = readFileSync(resolve(process.cwd(), file), 'utf8')
      expect(src, `${file}: кнопка справки снята с экрана`).toContain(`<HelpButton topic="${topic}"`)
    }
  })
})

describe('llms.txt', () => {
  it('индекс ссылается на каждую тему и на полный файл', () => {
    const txt = buildLlmsTxt('https://polls.example')
    expect(txt).toContain('https://polls.example/llms-full.txt')
    for (const t of HELP_TOPICS) {
      expect(txt).toContain(`https://polls.example/docs#${t.key}`)
      expect(txt).toContain(t.summary)
    }
  })

  it('без домена ссылки относительные, а не «https://undefined»', () => {
    const txt = buildLlmsTxt('')
    expect(txt).toContain('](/llms-full.txt)')
    expect(txt).not.toContain('undefined')
  })

  it('полный файл содержит ВСЕ темы целиком', () => {
    const full = buildLlmsFullTxt()
    for (const t of HELP_TOPICS) {
      expect(full).toContain(`## ${t.title}`)
      for (const s of t.sections) for (const p of s.paragraphs ?? []) expect(full).toContain(p)
    }
  })

  it('markdown темы устойчив: списки закрываются пустой строкой, заголовки на месте', () => {
    const md = topicMarkdown(HELP_TOPICS[0]!)
    expect(md.startsWith('## ')).toBe(true)
    expect(md).not.toMatch(/\n- [^\n]*\n##/)
  })
})

describe('роуты llms — тонкие адаптеры', () => {
  // У server/** нет порога покрытия; роуты обязаны только отдавать построенное чистыми функциями.
  const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8')
  it('llms.txt строится реестром, с типом text/plain и без своей логики', () => {
    const src = read('server/routes/llms.txt.get.ts')
    expect(src).toContain('buildLlmsTxt(')
    expect(src).toContain('text/plain; charset=utf-8')
  })
  it('llms-full.txt строится реестром', () => {
    const src = read('server/routes/llms-full.txt.get.ts')
    expect(src).toContain('buildLlmsFullTxt(')
    expect(src).toContain('text/plain; charset=utf-8')
  })
})
