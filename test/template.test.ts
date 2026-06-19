import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { compile } from '../src/domain/compile'
import { surveyDraftSchema } from '../src/domain/schema'

/**
 * Гарантирует, что обезличенный шаблон опроса остаётся валидным черновиком
 * движка (раньше он использовал иные имена полей и не имел metric — расходился
 * со schema.ts). Тест ловит любой будущий дрейф шаблона относительно схемы.
 */
const templatePath = fileURLToPath(new URL('../docs/reference/survey-schema.template.json', import.meta.url))
const raw = JSON.parse(readFileSync(templatePath, 'utf8'))

describe('survey-schema.template.json', () => {
  it('парсится surveyDraftSchema без ошибок', () => {
    const r = surveyDraftSchema.safeParse(raw)
    expect(r.success).toBe(true)
  })

  it('компилируется в версию из 25 вопросов с уникальными ключами', () => {
    const draft = surveyDraftSchema.parse(raw)
    const v = compile(draft, 1)
    expect(v.questions).toHaveLength(25)
    expect(new Set(v.questions.map((q) => q.key)).size).toBe(25)
  })

  it('содержит презентационные поля (intro/thanks/blocks) — часть схемы, #25', () => {
    expect(typeof raw.intro.count).toBe('string')
    expect(raw.intro.count).toContain(String(raw.questions.length)) // счётчик отражает число вопросов
    expect(raw.blocks).toHaveLength(8)
    expect(raw.thanks.title).toBeTruthy()
  })

  it('замораживает презентацию в версию-снимок (version-frozen, #25)', () => {
    const draft = surveyDraftSchema.parse(raw)
    const v = compile(draft, 1)
    // intro/thanks/blocks доезжают до CompiledVersion, а не отбрасываются.
    expect(v.intro?.cta).toBe(raw.intro.cta)
    expect(v.intro?.meta).toEqual(raw.intro.meta)
    expect(v.thanks?.title).toBe(raw.thanks.title)
    expect(v.blocks).toEqual(raw.blocks)
    // имена блоков покрывают все question.block (презентация согласована с вопросами).
    const used = new Set(v.questions.map((q) => q.block))
    for (const b of used) expect(v.blocks).toContain(b)
  })
})
