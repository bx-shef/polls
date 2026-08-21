import { z } from 'zod'

/**
 * Потолок числа вопросов в черновике.
 *
 * ⚠️ Вынесен из инлайна намеренно: на него ОПИРАЕТСЯ страница просмотра результата
 * (`RESULT_VIEW_MAX_LINES`, #18). Пока число жило только здесь, связь была невыраженной — подними
 * кто-нибудь потолок, и страница молча печатала бы «Вопросов без ответа: N» про ОТВЕЧЕННЫЕ вопросы.
 * Теперь расхождение ловит тест.
 */
export const MAX_QUESTIONS = 200


/**
 * Доменные типы движка опроса.
 * Соответствуют модели данных (docs/project-map.md): вопрос с метрикой и
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

/**
 * Тип сущности Bitrix24, к которой привязан опрос (датчик запуска). На каждое направление
 * и тип сущности можно завести 1+ опрос. `deal` — дефолт (обратная совместимость: ранние
 * опросы без поля считаются «по сделке»). `spa` — смарт-процесс (crm.item, динамический тип).
 * Стадии/статусы триггера портал-специфичны и лежат в `invitationPolicy.triggerStages`.
 *
 * ВНИМАНИЕ (фаза мульти-сущность): сейчас боевой триггер — ТОЛЬКО `deal` (`deal-event.ts` +
 * `surveysTriggeredBy` по `stageId`). Прочие типы — задекларированы в модели, но датчик ещё не
 * подключён: у `spa` — свой namespace стадий. До реализации фазы выбор не-deal сущности
 * приглашений не создаёт.
 */
export const ENTITY_TYPES = ['deal', 'lead', 'spa', 'contact', 'company'] as const
export type EntityType = (typeof ENTITY_TYPES)[number]

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
  /**
   * Тип сущности-датчика (deal/lead/spa/contact/company). Дефолт `deal` —
   * обратная совместимость с опросами без явной привязки. `triggerStages` трактуются
   * в терминах этой сущности (стадии сделки / статусы лида / стадии смарт-процесса и т.п.).
   */
  entityType: z.enum(ENTITY_TYPES).default('deal'),
  /**
   * id смарт-процесса (`entityTypeId` crm.item), когда `entityType === 'spa'` —
   * динамические типы различаются только числовым id. Для прочих сущностей не нужен.
   * Верхняя граница — INT4_MAX (id Bitrix24 укладываются; защита от мусора в payload).
   */
  spaEntityTypeId: z.number().int().positive().max(2147483647).optional(),
  /** stage_id Bitrix24, переход в которые запускает опрос (портал-специфичны). */
  triggerStages: z.array(z.string().min(1).max(200)).max(50).default([]),
  /** Порядок проб каналов: первый доступный — победитель (см. chooseChannel). Без дублей.
   *  Дефолт email→sms — условный, пересмотреть при добавлении каналов. */
  channelOrder: z
    .array(z.enum(INVITE_CHANNELS))
    .refine((a) => new Set(a).size === a.length, { message: 'channelOrder: каналы не должны повторяться' })
    .default(['email', 'sms']),
  /**
   * Срок доступности ссылки на опрос (в СЕКУНДАХ) — сколько живёт токен приглашения от выписки.
   * Продуктовое требование: настраивается на КАЖДЫЙ опрос в диапазоне [300, 432000] = [5 минут, 5 дней]
   * (вне диапазона → parse-ошибка на границе `compile`/PgStore-read, а не тихий кламп). **Живой гейт по
   * истечению — на `POST /api/submit`:** `consume` протухшего токена → 403 (`handlers.ts`). На уровне стора
   * оба метода (`peek`/`consume`) чистят протухшее по `exp` (`prune`), поэтому и будущий предпросмотр по
   * токену (`peek`) не отдаст истёкшее приглашение — но HTTP-роут предпросмотра по токену пока не подключён
   * (страница `/s/:key` отдаёт публичный контент без токена). **Необязателен:** не задан → падает на дефолт
   * стора приглашений (30 дней, back-compat со старыми опросами и НОВЫМИ версиями без явного поля — потолок
   * 5 дней валидирует лишь ЗАДАННОЕ значение, глобальным инвариантом не является; UI-пикер дефолтит в диапазон);
   * задан → окно строго в [5 мин, 5 дней]. Version-frozen (едет в compiled_schema JSONB — миграции не нужно).
   */
  linkTtlSeconds: z.number().int().min(300).max(432000).optional(),
  /**
   * Класть ли ИНДИВИДУАЛЬНЫЙ результат этого опроса в таймлайн сделки (#18).
   *
   * ⚠️ Гейт нужен потому, что запись в карточку — это качественно другое раскрытие, чем дашборд.
   * Дашборд показывает агрегаты и режет малые выборки (`ANONYMITY_THRESHOLD`); дело в таймлайне
   * показывает менеджеру, что ответил ИМЕННО ЭТОТ клиент по ИМЕННО ЭТОЙ сделке. Опрос, который на
   * интро обещает «Анонимно», обязан иметь здесь `false` — иначе обещание нарушается ровно в тот
   * момент, когда человек уже ответил и сделать ничего не может.
   *
   * ⚠️ Имя — по ДЕЙСТВИЮ, а не по обещанию. Поле `anonymous` читалось бы как гарантия
   * несвязываемости по всей системе, а её нет: снимок CRM едет в приглашении, а дашборд даёт срезы
   * по клиенту и ответственному выше порога. Флаг отвечает ровно за одно — уходит ли ответ в карточку.
   *
   * ⚠️ Поле **необязательное**, а не `.default(true)`, и это не мелочь: «поле не задано» и «политики
   * нет вовсе» обязаны значить одно и то же, а решает это ОДНА функция —
   * `resultToTimelineEnabled` (`domain/invitation.ts`). Дефолт в схеме дал бы второе место, где
   * написано «по умолчанию кладём», и однажды они разъехались бы. Тот же приём, что у
   * `linkTtlSeconds`.
   *
   * Умолчание — «кладём»: возврат результата в сделку и есть смысл продукта («датчик → CRM»).
   * Контрол в конструкторе — [#118](https://github.com/bx-shef/polls/issues/118).
   *
   * ⚠️ Чип «Анонимно» на интро (`intro.meta`) — СВОБОДНЫЙ ТЕКСТ, схема его не читает и читать не
   * может: это произвольная строка на произвольном языке. Согласовать обещание с этим флагом обязан
   * автор опроса — переключатель стоит в конструкторе рядом со стадиями-триггерами именно поэтому.
   *
   * ⚠️ Демо-опрос (`demo/seed.ts`) чип несёт, а политики не имеет вовсе — он служит фикстурой пути
   * «политики нет» (`test/compile.test.ts`, `test/store.test.ts`). И это НЕ безобидно: его ключ
   * совпадает с `DEFAULT_SURVEY_KEY`, демо засевается в пустую базу, а установка присваивает
   * плейсхолдер вместе с ним — на портале без заданных `SURVEY_KEY_*` виджет сделки выпишет
   * приглашение именно на демо-опрос, с чипом «Анонимно» и умолчанием «кладём». Развязка демо и
   * продуктового дефолта — [#187](https://github.com/bx-shef/polls/issues/187).
   */
  resultToTimeline: z.boolean().optional()
  })
  // Инвариант: spaEntityTypeId осмыслен ТОЛЬКО для смарт-процесса (spa требует id, прочие — запрещают),
  // иначе тихо-проглоченное поле = скрытая неконсистентность привязки.
  .superRefine((p, ctx) => {
    if (p.entityType === 'spa' && p.spaEntityTypeId === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['spaEntityTypeId'], message: 'spaEntityTypeId обязателен для entityType=spa' })
    }
    if (p.entityType !== 'spa' && p.spaEntityTypeId !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['spaEntityTypeId'], message: 'spaEntityTypeId допустим только при entityType=spa' })
    }
  })
export type InvitationPolicy = z.infer<typeof invitationPolicySchema>

/**
 * Презентационный слой опроса (#25): контент экранов Интро/Спасибо и
 * упорядоченные имена блоков. Нужен Vue-слою (docs/project-map.md, §Дизайн (b24ui)); едет в
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

/**
 * Предел размера черновика в БАЙТАХ сериализованного JSON.
 *
 * **Зачем предел на целое, если у каждого поля свой.** Поштучные пределы перемножаются: 200 вопросов ×
 * (2000 символов текста + 100 опций по 700) дают теоретический максимум **14,4 млн символов** — около
 * 27 МБ, если тексты русские (в UTF-8 кириллица занимает два байта). Это на два-три порядка больше,
 * чем можно отправить (кап роута публикации — 64 КБ). То есть схема принимала
 * черновики, которые физически не доедут до сервера, и человек узнавал об этом **в момент публикации**,
 * когда работа уже сделана, а черновик нигде не сохранён. Отказ приходил общий («слишком большой
 * объём»), то есть буквально «удалите что-нибудь».
 *
 * Поэтому граница ставится в ядре, рядом с остальной валидацией, — но на схеме ГРАНИЦЫ ЗАПИСИ
 * (`publishableDraftSchema`), а не на общей: см. её JSDoc.
 *
 * ⚠️ **Этот предел и кап тела у роута меряют РАЗНОЕ, и одно из другого не следует.** Здесь считается
 * разобранное значение — то, что ляжет в хранилище; кап роута считает `Content-Length`, то есть провод.
 * Расходятся они в обе стороны: zod дописывает дефолты (`required`, `options: []`, `lang`), и
 * разобранное бывает до полутора раз БОЛЬШЕ присланного; наоборот, `\uXXXX`-экранирование и лишние
 * ключи, которые zod отбрасывает, делают провод больше разобранного. Поэтому «прошло схему ⇒ влезет в
 * транспорт» — неверно, и обещать этого нельзя: за провод отвечает кап роута, за хранимое — этот предел.
 * Тест держит лишь то, что здешний предел строго ниже капа роута.
 *
 * Величина: 60 КБ при капе роута 64 КБ. Для ориентира: обезличенный шаблон на 25 вопросов — 13,1 КБ
 * (537 Б на вопрос), то есть предел это примерно 114 вопросов такой плотности.
 *
 * Байты, а не символы: тексты русские, в UTF-8 кириллическая буква занимает два байта, и счёт по
 * символам занизил бы реальный размер вдвое — ровно на границе это и подвело бы.
 */
export const MAX_DRAFT_BYTES = 60 * 1024

/** Метка нашего отказа по размеру — чтобы вызывающий опознавал его, не разбирая текст. */
export const DRAFT_TOO_LARGE = 'draft_too_large'

/** Размер черновика в байтах UTF-8 — как он поедет по сети. */
export function draftByteSize(draft: unknown): number {
  return new TextEncoder().encode(JSON.stringify(draft)).length
}

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
  questions: z.array(questionSchema).min(1).max(MAX_QUESTIONS),
  /** Политика приглашения (опц.): когда и каким каналом звать клиента. */
  invitationPolicy: invitationPolicySchema.optional()
})
export type SurveyDraft = z.infer<typeof surveyDraftSchema>

/**
 * Схема ГРАНИЦЫ ЗАПИСИ: тот же черновик плюс предел размера.
 *
 * ⚠️ Почему предел НЕ в `surveyDraftSchema`. Эта схема двунаправленная: ею же читают обратно —
 * `versionToDraft` разбирает опубликованную версию, чтобы отдать её редактору. Стоило поставить предел
 * в неё, и опрос, опубликованный ДО появления предела, переставал открываться на правку (500). То есть
 * единственный способ его сократить — открыть — и отказывал. Это строго хуже, чем отказ на публикации:
 * там человек хотя бы не терял доступ к уже сделанному.
 *
 * Поэтому предел живёт только там, где принимают НОВОЕ. Читать старое он не мешает.
 */
export const publishableDraftSchema = surveyDraftSchema.superRefine((draft, ctx) => {
  // Меряем УЖЕ разобранное значение — то, что ляжет в хранилище. Оно не равно присланному телу
  // (см. `MAX_DRAFT_BYTES`), и меряем именно хранимое: за него мы отвечаем.
  const bytes = draftByteSize(draft)
  if (bytes > MAX_DRAFT_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: draftTooLargeMessage(bytes),
      // Метка, а не разбор текста: сообщение — пользовательский текст, его перепишут не задумываясь,
      // и вызывающий, опознающий отказ по подстроке, сломается молча.
      params: { kind: DRAFT_TOO_LARGE }
    })
  }
})

/**
 * Текст отказа для человека. Называет ОБЕ величины: без «сколько есть» и «сколько можно» совет
 * «сократите» невыполним — непонятно, на сколько сокращать.
 */
export function draftTooLargeMessage(bytes: number): string {
  // Округляем В РАЗНЫЕ стороны намеренно. При обычном округлении самый частый случай — «чуть перебрал»
  // — давал «60 КБ при пределе 60 КБ»: числа совпадали, и сообщение переставало объяснять отказ, то
  // есть вырождалось ровно там, ради чего написано. Вверх для факта, вниз для предела — они всегда
  // различаются, и оба честны (факт не занижен, предел не завышен).
  const actual = Math.ceil(bytes / 1024)
  const limit = Math.floor(MAX_DRAFT_BYTES / 1024)
  return `Опрос слишком большой: ${actual} КБ при пределе ${limit} КБ. `
    + 'Сократите тексты вопросов или уменьшите их число.'
}

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
  // Денормализованные имена (снимок на момент закрытия сделки) — чтобы срезы дашборда
  // (клиент/направление/ответственный) читались без обращения к CRM-справочникам, по аналогии
  // с `crmProduct.productName`. Опциональны: при отсутствии срез падает на ID.
  // ВНИМАНИЕ: `responsibleName` — PII (ФИО сотрудника); PII-редакция `context` — #31.
  companyName: z.string().max(500).optional(),
  dealCategoryName: z.string().max(500).optional(),
  responsibleName: z.string().max(500).optional(),
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
 * Публичная проекция версии для рендера контура A: всё, КРОМЕ `invitationPolicy`
 * (внутренняя CRM-конфигурация наружу не утекает, #25). Серверный `survey()` отдаёт
 * именно её; клиентские типы (composable/компоненты) используют этот тип, а не полный
 * `CompiledVersion` — чтобы случайно не отрендерить/не залогировать чувствительное поле.
 */
export type PublicVersion = Omit<CompiledVersion, 'invitationPolicy'>

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

/**
 * Отказ по размеру среди ошибок разбора — или `undefined`.
 *
 * Роут публикации на любую ошибку схемы отвечает общим «в опросе есть ошибки»: перечислять человеку
 * внутренности zod бессмысленно. Но «слишком большой» — не ошибка заполнения, а упёршийся предел, и
 * без чисел совет «сократите» невыполним. Поэтому именно этот отказ вынимается отдельно.
 */
export function draftTooLargeIssue(error: z.ZodError): string | undefined {
  const issue = error.issues.find(
    (i) => i.code === 'custom' && (i as { params?: { kind?: string } }).params?.kind === DRAFT_TOO_LARGE
  )
  return issue?.message
}
