import { z } from 'zod'

/**
 * Доменные типы движка опроса.
 * Соответствуют модели данных (docs/data-model.md): вопрос с метрикой и
 * стабильным ключом, вариант со стабильным ключом, ответ со снимком CRM-контекста.
 *
 * Перечисления и составные структуры выводятся из zod-схем (единый источник
 * истины), чтобы тип TS и runtime-валидация на границах не расходились.
 */

// ── Перечисления: один источник для типа TS и для z.enum ──
export const QUESTION_TYPES = ['single', 'multi', 'text'] as const
export type QuestionType = (typeof QUESTION_TYPES)[number]

// При добавлении метрики синхронизировать CHECK в migrations/0001_init.sql
// (survey_question.metric, response_answer.metric).
export const METRICS = ['nps', 'csat', 'ces', 'scale', 'choice', 'text'] as const
export type Metric = (typeof METRICS)[number]

/** Метрики, для которых ответ несёт число (берётся из option.score). */
export const NUMERIC_METRICS = new Set<Metric>(['nps', 'csat', 'ces', 'scale'])

/** Каналы доставки приглашения (invitation-flow #3); порядок задаёт опрос. */
export const INVITE_CHANNELS = ['email', 'sms'] as const
export type InviteChannel = (typeof INVITE_CHANNELS)[number]

/** ISO-8601 с таймзоной (напр. `2026-04-03T10:00:00.000Z`). */
const isoDatetime = z.string().datetime({ offset: true })

export const optionSchema = z.object({
  /** Стабильный ключ варианта — сохраняется между версиями. */
  key: z.string().min(1).max(200),
  label: z.string().max(500),
  /** Числовой балл для шкальных метрик (напр. 0..10 для NPS). nullish: null (из БД) либо отсутствие. */
  score: z.number().nullish(),
  isOther: z.boolean().optional(),
  isExclusive: z.boolean().optional()
})
export type Option = z.infer<typeof optionSchema>

export const questionSchema = z.object({
  /** Стабильный ключ вопроса — якорь сопоставимости между версиями. */
  key: z.string().min(1).max(200),
  block: z.string().max(200).optional(),
  type: z.enum(QUESTION_TYPES),
  metric: z.enum(METRICS),
  required: z.boolean().default(true),
  columns: z.number().int().positive().optional(),
  text: z.string().max(2000),
  options: z.array(optionSchema).max(100).default([])
})
export type Question = z.infer<typeof questionSchema>

/**
 * Политика приглашения опроса (invitation-flow): «когда звать» (стадии-триггеры
 * сделки) и «каким каналом» (порядок проб). Объявлена ДО surveyDraftSchema, т.к.
 * вшита в него и в compiledVersion (#17); persists в survey_version.compiled_schema.
 */
export const invitationPolicySchema = z.object({
  /** stage_id Bitrix24, переход в которые запускает опрос (портал-специфичны). */
  triggerStages: z.array(z.string().min(1).max(200)).max(50).default([]),
  /** Порядок проб каналов: первый доступный — победитель (см. chooseChannel). Без дублей.
   *  Дефолт email→sms — условный, пересмотреть при добавлении каналов. */
  channelOrder: z
    .array(z.enum(INVITE_CHANNELS))
    .refine((a) => new Set(a).size === a.length, { message: 'channelOrder: каналы не должны повторяться' })
    .default(['email', 'sms'])
})
export type InvitationPolicy = z.infer<typeof invitationPolicySchema>

/**
 * Презентационный слой опроса (#25): контент экранов Интро/Спасибо и
 * упорядоченные имена блоков. Нужен Vue-слою (design.md §4/§6); едет в
 * версию-снимок (version-frozen, как остальной контент анкеты). `SurveyFill`
 * это не трогает — он про прохождение, а не презентацию.
 */
export const introSchema = z.object({
  /** Вордмарк-бренд на интро. */
  wordmark: z.string().max(200).optional(),
  /** Метка года/кампании (моно). */
  year: z.string().max(50).optional(),
  /** Надзаголовок-кикер. */
  kicker: z.string().max(500).optional(),
  /** Крупный заголовок (может быть многострочным, `\n`). */
  title: z.string().max(1000).optional(),
  /** Лид-абзац. */
  lead: z.string().max(2000).optional(),
  /** Ряд «чипов» (напр. «Анонимно», «~N минут»). */
  meta: z.array(z.string().max(200)).max(20).default([]),
  /** Текст CTA-кнопки. */
  cta: z.string().max(200).optional(),
  /** Подпись под CTA (напр. «25 вопросов · 8 блоков»). */
  count: z.string().max(200).optional()
})
export type Intro = z.infer<typeof introSchema>

export const thanksSchema = z.object({
  title: z.string().max(500).optional(),
  body: z.string().max(2000).optional(),
  note: z.string().max(2000).optional()
})
export type Thanks = z.infer<typeof thanksSchema>

export const surveyDraftSchema = z.object({
  surveyKey: z.string().min(1).max(200),
  title: z.string().max(500),
  /** Один опрос = один язык (решение №3). */
  lang: z.string().max(20).default('ru'),
  /** Контент экрана Интро (опц.; нужен фронту, #25). */
  intro: introSchema.optional(),
  /** Контент экрана Спасибо (опц.; нужен фронту, #25). */
  thanks: thanksSchema.optional(),
  /** Упорядоченные отображаемые имена блоков (совпадают с `question.block`). */
  blocks: z.array(z.string().max(200)).max(50).optional(),
  questions: z.array(questionSchema).min(1).max(200),
  /** Политика приглашения (опц.): когда и каким каналом звать клиента. */
  invitationPolicy: invitationPolicySchema.optional()
})
export type SurveyDraft = z.infer<typeof surveyDraftSchema>

/** Снимок CRM-контекста, снятый при закрытии сделки. */
export const crmProductSchema = z.object({
  productId: z.number(),
  productName: z.string().max(500).optional(),
  serviceTag: z.string().max(500).optional()
})
export type CrmProduct = z.infer<typeof crmProductSchema>

export const crmContextSchema = z.object({
  dealId: z.number().optional(),
  dealCategoryId: z.number().optional(),
  dealStageId: z.string().optional(),
  companyId: z.number().optional(),
  contactId: z.number().optional(),
  responsibleId: z.number().optional(),
  dealAmount: z.number().optional(),
  products: z.array(crmProductSchema).max(50).optional()
})
export type CrmContext = z.infer<typeof crmContextSchema>

/**
 * Приглашение (invitation-flow #3): связывает одноразовый токен со СНИМКОМ
 * CRM-контекста (на момент закрытия сделки) и пином опроса/версии. На submit
 * токен резолвится → context приглашения становится ResponseRecord.context.
 * ПДн адресата (email/phone) НЕ храним — канал резолвит binding-слой при отправке.
 */
export const invitationSchema = z.object({
  token: z.string().min(1).max(200),
  surveyKey: z.string().min(1).max(200),
  versionNo: z.number().int().positive(),
  context: crmContextSchema,
  status: z.enum(['pending', 'used']),
  createdAt: isoDatetime,
  /** ISO-срок жизни; `undefined` — бессрочно. MemoryInvitationStore всегда задаёт TTL. */
  expiresAt: isoDatetime.optional()
})
export type Invitation = z.infer<typeof invitationSchema>

/** Иммутабельная опубликованная версия — её отдаёт фронт и к ней привязаны ответы. */
export const compiledVersionSchema = z.object({
  surveyKey: z.string().min(1).max(200),
  title: z.string().max(500),
  lang: z.string().max(20),
  versionNo: z.number().int().positive(),
  /** Презентация экранов Интро/Спасибо/имена блоков — заморожена с версией (#25). */
  intro: introSchema.optional(),
  thanks: thanksSchema.optional(),
  blocks: z.array(z.string().max(200)).max(50).optional(),
  questions: z.array(questionSchema),
  /** Политика приглашения (опц.), заморожена с версией (в compiled_schema JSONB).
   *  Денормализация triggerStages под запрос «по стадии» — при binding (#17). */
  invitationPolicy: invitationPolicySchema.optional(),
  compiledAt: isoDatetime
})
export type CompiledVersion = z.infer<typeof compiledVersionSchema>

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
    surveyKey: z.string().min(1).max(200),
    versionNo: z.number().int().positive(),
    answers: z.record(z.string().max(200), rawAnswerSchema)
  })
  .refine((s) => Object.keys(s.answers).length <= 200, {
    message: 'Слишком много ответов в payload'
  })
export type Submission = z.infer<typeof submissionSchema>

/** Нормализованный ответ на вопрос — хранится в БД. */
export const storedAnswerSchema = z.object({
  questionKey: z.string().min(1).max(200),
  metric: z.enum(METRICS),
  /** option_key[] выбранных вариантов. */
  valueChoice: z.array(z.string().max(200)),
  /** Число для nps/csat/ces/scale (из option.score). */
  valueNumber: z.number().nullable(),
  /** Свободный текст, включая «Другое». */
  valueText: z.string().nullable()
})
export type StoredAnswer = z.infer<typeof storedAnswerSchema>

/** Завершённая анкета со снимком контекста. */
export const responseRecordSchema = z.object({
  // id записи: в MemoryStore — строка (seed r1..r12); в PgStore — bigint/UUID как строка.
  id: z.string().min(1).max(200),
  surveyKey: z.string().min(1).max(200),
  versionNo: z.number().int().positive(),
  /** ISO-8601 с таймзоной. */
  submittedAt: isoDatetime,
  context: crmContextSchema,
  answers: z.array(storedAnswerSchema),
  /**
   * Токен приглашения, по которому сделана запись (опц.). Durable-якорь
   * идемпотентности: PgStore кладёт его в колонку с частичным UNIQUE
   * (portal_id, invitation_token), поэтому повторная отправка того же
   * приглашения на ЛЮБОЙ инстанс не создаёт дубль (#3/#4, мульти-инстанс).
   * Публичные ответы по ссылке без приглашения — без токена (дедуп не нужен).
   */
  invitationToken: z.string().min(1).max(256).optional()
})
export type ResponseRecord = z.infer<typeof responseRecordSchema>
