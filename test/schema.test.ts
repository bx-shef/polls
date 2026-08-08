import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  crmContextSchema,
  optionSchema,
  questionSchema,
  rawAnswerSchema,
  responseRecordSchema,
  submissionSchema,
  surveyDraftSchema,
  MAX_DRAFT_BYTES,
  DRAFT_TOO_LARGE,
  draftByteSize,
  draftTooLargeIssue
} from '../src/domain/schema'

describe('rawAnswerSchema — границы payload', () => {
  it('принимает валидный ответ и пустой объект (вопрос пропущен)', () => {
    expect(rawAnswerSchema.safeParse({ values: ['a'], text: 'hi' }).success).toBe(true)
    expect(rawAnswerSchema.safeParse({}).success).toBe(true)
  })

  it('отклоняет слишком длинный текст (>2000)', () => {
    expect(rawAnswerSchema.safeParse({ text: 'x'.repeat(2001) }).success).toBe(false)
  })

  it('отклоняет слишком много значений (>100)', () => {
    expect(rawAnswerSchema.safeParse({ values: Array(101).fill('a') }).success).toBe(false)
  })
})

describe('submissionSchema — границы', () => {
  const ok = { surveyKey: 's', versionNo: 1, answers: { q1: { values: ['a'] } } }

  it('принимает валидный сабмишен', () => {
    expect(submissionSchema.safeParse(ok).success).toBe(true)
  })

  it('отклоняет пустой surveyKey', () => {
    expect(submissionSchema.safeParse({ ...ok, surveyKey: '' }).success).toBe(false)
  })

  it('отклоняет отрицательный versionNo', () => {
    expect(submissionSchema.safeParse({ ...ok, versionNo: -1 }).success).toBe(false)
  })

  it('отклоняет versionNo = 0 (версии нумеруются с 1)', () => {
    expect(submissionSchema.safeParse({ ...ok, versionNo: 0 }).success).toBe(false)
  })

  it('отклоняет слишком много ответов (>200)', () => {
    const answers: Record<string, { values: string[] }> = {}
    for (let i = 0; i < 201; i++) answers[`q${i}`] = { values: ['a'] }
    expect(submissionSchema.safeParse({ ...ok, answers }).success).toBe(false)
  })
})

describe('questionSchema / optionSchema — прямая валидация', () => {
  it('optionSchema: score может быть null', () => {
    expect(optionSchema.safeParse({ key: 'a', label: 'A', score: null }).success).toBe(true)
  })
  it('questionSchema: неизвестная метрика отклоняется', () => {
    expect(questionSchema.safeParse({ key: 'q', type: 'single', metric: 'bad', text: 'x' }).success).toBe(false)
  })
  it('questionSchema: >100 вариантов отклоняется', () => {
    const options = Array.from({ length: 101 }, (_, i) => ({ key: `o${i}`, label: 'x' }))
    expect(questionSchema.safeParse({ key: 'q', type: 'single', metric: 'choice', text: 'x', options }).success).toBe(false)
  })
  it('surveyDraftSchema: >200 вопросов отклоняется', () => {
    const questions = Array.from({ length: 201 }, (_, i) => ({ key: `q${i}`, type: 'text', metric: 'text', text: 'x' }))
    expect(surveyDraftSchema.safeParse({ surveyKey: 's', title: 't', questions }).success).toBe(false)
  })
})

describe('responseRecordSchema — валидация на границе записи', () => {
  const ok = {
    id: 'r1', surveyKey: 's', versionNo: 1, submittedAt: '2026-04-01T10:00:00.000Z',
    context: {}, answers: []
  }
  it('принимает валидную запись и пустой контекст', () => {
    expect(responseRecordSchema.safeParse(ok).success).toBe(true)
  })
  it('отклоняет невалидный submittedAt (не ISO-datetime)', () => {
    expect(responseRecordSchema.safeParse({ ...ok, submittedAt: '2026-04-01' }).success).toBe(false)
  })
  it('crmContext с числовыми id валиден', () => {
    expect(crmContextSchema.safeParse({ companyId: 5, dealId: 9, products: [{ productId: 1 }] }).success).toBe(true)
  })
  it('crmContext принимает денормализованные имена (опциональны)', () => {
    expect(crmContextSchema.safeParse({ companyId: 5, companyName: 'ООО Ромашка', dealCategoryName: 'Продажи', responsibleName: 'Иванов' }).success).toBe(true)
    expect(crmContextSchema.safeParse({ companyId: 5 }).success).toBe(true) // без имён — тоже валидно
  })
  it('crmContext отвергает слишком длинное имя (>500)', () => {
    expect(crmContextSchema.safeParse({ responsibleName: 'X'.repeat(501) }).success).toBe(false)
  })
})

/**
 * Предел размера черновика.
 *
 * Поштучные пределы полей перемножаются, и произведение оказалось на два порядка больше, чем можно
 * отправить: схема принимала черновики, которые физически не доедут до роута публикации. Человек
 * узнавал об этом в момент публикации — когда работа сделана, а черновик нигде не сохранён.
 */
describe('surveyDraftSchema: размер черновика', () => {
  const fill = (n: number) => 'я'.repeat(n) // кириллица: 2 байта на символ в UTF-8

  it('предел строго меньше капа роута публикации — иначе он ничего не гарантирует', () => {
    // Инвариант всей затеи: черновик, прошедший схему, ОБЯЗАН влезать в транспорт. Кап роута читаем
    // из его исходника, а не дублируем числом: разъедутся — тест покажет.
    const route = readFileSync(
      fileURLToPath(new URL('../server/api/admin/surveys/[key]/publish.post.ts', import.meta.url)),
      'utf8'
    )
    const m = /MAX_BODY_BYTES\s*=\s*(\d+)\s*\*\s*(\d+)/.exec(route)
    expect(m, 'кап роута публикации не найден — изменилась запись?').not.toBeNull()
    const routeCap = Number(m?.[1]) * Number(m?.[2])
    expect(MAX_DRAFT_BYTES).toBeLessThan(routeCap)
    expect(MAX_DRAFT_BYTES).toBe(61440)
  })

  it('черновик сверх предела отклоняется, и в тексте есть ОБЕ величины', () => {
    // Без «сколько есть» и «сколько можно» совет «сократите» невыполним.
    const big = {
      surveyKey: 's',
      title: 't',
      questions: [{ key: 'q1', type: 'text', metric: 'text', text: fill(40_000) }]
    }
    const r = surveyDraftSchema.safeParse(big)
    expect(r.success).toBe(false)
    if (r.success) return
    const msg = draftTooLargeIssue(r.error)
    expect(msg).toBeDefined()
    expect(msg).toContain('60 КБ')
    expect(msg).toMatch(/\d+ КБ при пределе/)
  })

  it('отказ помечен, а не опознаётся по подстроке', () => {
    // Сообщение — пользовательский текст, его перепишут не задумываясь; вызывающий, разбирающий
    // текст, сломается молча.
    const r = surveyDraftSchema.safeParse({
      surveyKey: 's', title: 't',
      questions: [{ key: 'q1', type: 'text', metric: 'text', text: fill(40_000) }]
    })
    expect(r.success).toBe(false)
    if (r.success) return
    const issue = r.error.issues.find((i) => i.code === 'custom')
    expect((issue as { params?: { kind?: string } }).params?.kind).toBe(DRAFT_TOO_LARGE)
    // Обычная ошибка заполнения меткой размера НЕ помечается.
    const other = surveyDraftSchema.safeParse({ surveyKey: 's', title: 't', questions: [] })
    expect(other.success).toBe(false)
    if (!other.success) expect(draftTooLargeIssue(other.error)).toBeUndefined()
  })

  it('реальный черновик проходит с запасом', () => {
    // Предел обязан быть выше того, что мы сами показываем как образец, иначе он ломает наш же
    // сценарий демонстрации.
    const template = JSON.parse(
      readFileSync(fileURLToPath(new URL('../docs/reference/survey-schema.template.json', import.meta.url)), 'utf8')
    )
    expect(surveyDraftSchema.safeParse(template).success).toBe(true)
    expect(draftByteSize(template)).toBeLessThan(MAX_DRAFT_BYTES / 2)
  })

  it('счёт в БАЙТАХ, а не в символах — тексты русские', () => {
    // В UTF-8 кириллица занимает два байта. Счёт по символам занизил бы размер вдвое, и ровно на
    // границе черновик прошёл бы схему, а транспорт его отверг — то есть предел не работал бы там,
    // где он единственно и нужен.
    expect(draftByteSize({ a: 'яя' })).toBeGreaterThan(JSON.stringify({ a: 'яя' }).length)
  })
})
