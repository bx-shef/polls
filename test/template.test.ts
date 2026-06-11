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

  it('содержит UX-поля фронта (intro/thanks/blocks), которые движок игнорирует', () => {
    // intro/thanks/blocks — контракт фронта, вне SurveyDraft: surveyDraftSchema их
    // отбрасывает (strip), но в файле-шаблоне они нужны для рендера UI.
    expect(typeof raw.intro.count).toBe('string')
    expect(raw.intro.count).toContain(String(raw.questions.length)) // счётчик отражает число вопросов
    expect(raw.blocks).toHaveLength(8)
    expect(raw.thanks.title).toBeTruthy()
  })
})
