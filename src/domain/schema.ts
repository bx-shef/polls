import { z } from 'zod'

/**
 * Доменные типы движка опроса.
 * Соответствуют модели данных (docs/data-model.md): вопрос с метрикой и
 * стабильным ключом, вариант со стабильным ключом, ответ со снимком CRM-контекста.
 */

export type QuestionType = 'single' | 'multi' | 'text'
export type Metric = 'nps' | 'csat' | 'ces' | 'scale' | 'choice' | 'text'

export const optionSchema = z.object({
  /** Стабильный ключ варианта — сохраняется между версиями. */
  key: z.string().min(1),
  label: z.string(),
  /** Числовой балл для шкальных метрик (напр. 0..10 для NPS). */
  score: z.number().nullish(),
  isOther: z.boolean().optional(),
  isExclusive: z.boolean().optional()
})
export type Option = z.infer<typeof optionSchema>

export const questionSchema = z.object({
  /** Стабильный ключ вопроса — якорь сопоставимости между версиями. */
  key: z.string().min(1),
  block: z.string().optional(),
  type: z.enum(['single', 'multi', 'text']),
  metric: z.enum(['nps', 'csat', 'ces', 'scale', 'choice', 'text']),
  required: z.boolean().default(true),
  columns: z.number().int().positive().optional(),
  text: z.string(),
  options: z.array(optionSchema).default([])
})
export type Question = z.infer<typeof questionSchema>

export const surveyDraftSchema = z.object({
  surveyKey: z.string().min(1),
  title: z.string(),
  /** Один опрос = один язык (решение №3). */
  lang: z.string().default('ru'),
  questions: z.array(questionSchema).min(1)
})
export type SurveyDraft = z.infer<typeof surveyDraftSchema>

/** Иммутабельная опубликованная версия — её отдаёт фронт и к ней привязаны ответы. */
export interface CompiledVersion {
  surveyKey: string
  title: string
  lang: string
  versionNo: number
  questions: Question[]
  compiledAt: string
}

/** Снимок CRM-контекста, снятый при закрытии сделки. */
export interface CrmProduct {
  productId: number
  productName?: string
  serviceTag?: string
}

export interface CrmContext {
  dealId?: number
  dealCategoryId?: number
  dealStageId?: string
  companyId?: number
  contactId?: number
  responsibleId?: number
  dealAmount?: number
  products?: CrmProduct[]
}

/**
 * Сырой ответ клиента на один вопрос. Оба поля опциональны: пустой объект `{}`
 * означает «вопрос пропущен». Границы (.max) — защита от раздувания payload.
 */
export const rawAnswerSchema = z.object({
  values: z.array(z.string().max(200)).max(100).optional(),
  text: z.string().max(2000).optional()
})
export type RawAnswer = z.infer<typeof rawAnswerSchema>

export const submissionSchema = z
  .object({
    surveyKey: z.string().max(200),
    versionNo: z.number().int().nonnegative(),
    answers: z.record(z.string().max(200), rawAnswerSchema)
  })
  .refine((s) => Object.keys(s.answers).length <= 200, {
    message: 'Слишком много ответов в payload'
  })
export type Submission = z.infer<typeof submissionSchema>

/** Нормализованный ответ на вопрос — хранится в БД. */
export interface StoredAnswer {
  questionKey: string
  metric: Metric
  /** option_key[] выбранных вариантов. */
  valueChoice: string[]
  /** Число для nps/csat/ces/scale (из option.score). */
  valueNumber: number | null
  /** Свободный текст, включая «Другое». */
  valueText: string | null
}

/** Завершённая анкета со снимком контекста. */
export interface ResponseRecord {
  id: string
  surveyKey: string
  versionNo: number
  /** ISO-8601. */
  submittedAt: string
  context: CrmContext
  answers: StoredAnswer[]
}
