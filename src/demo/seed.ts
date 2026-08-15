import { buildResponseAnswers } from '../domain/answers'
import { MemoryStore } from '../store/memory'
import type { IStore } from '../store/types'
import type { Option, RawAnswer, SurveyDraft } from '../domain/schema'

/**
 * Детерминированный демо-набор: один опрос, две версии (с правкой текста и
 * добавленным вариантом) и 12 ответов с разным CRM-контекстом. Общий для
 * `pnpm verify` и тестов, поэтому итог воспроизводим.
 */

export const SURVEY_KEY = 'csat_postdeal'

/**
 * Токен первого демо-приглашения. Фиксирован — чтобы демо умело показать ГЛАВНЫЙ путь: ссылку из
 * CRM, а не «голый» опрос без привязки. Второй — `DEMO_INVITATION_TOKEN_2`, на другую сделку.
 *
 * ⚠️ Не секрет: заводится только в демо-режиме (без `DATABASE_URL`), где данных нет вовсе, а
 * контекст под ним — выдуманная сделка. В боевом режиме приглашения выписывает только связка с
 * порталом, и этого токена там не существует.
 */
export const DEMO_INVITATION_TOKEN = 'demo-invitation'

/**
 * Второе демо-приглашение — на ДРУГУЮ сделку. Нужно не для полноты: без него нельзя показать (и
 * проверить) главное правило привязки — что две ссылки это две разные сделки, и черновик по одной
 * не переносится на другую.
 */
export const DEMO_INVITATION_TOKEN_2 = 'demo-invitation-2'

/** Снимок «сделки», под которым демо-приглашение привязывает ответ. Данные вымышленные. */
export const DEMO_INVITATION_CONTEXT = {
  dealId: 1001,
  dealStageId: 'WON',
  companyId: 501,
  responsibleId: 7,
  dealCategoryId: 1,
  dealAmount: 120_000,
  // ⚠️ Денормализованные ИМЕНА обязательны, а не украшение: срезы дашборда (клиент / направление /
  // ответственный) читают именно их, и без них демо показало бы срезы по голым ID — то есть не
  // показало бы того, ради чего заведено.
  companyName: 'ООО «Ромашка»',
  dealCategoryName: 'Продажи',
  responsibleName: 'Иванов Иван'
} as const

/** Снимок второй «сделки» — другой клиент и другой ответственный, чтобы разница была видна. */
export const DEMO_INVITATION_CONTEXT_2 = {
  dealId: 1002,
  dealStageId: 'WON',
  companyId: 502,
  responsibleId: 8,
  dealCategoryId: 2,
  dealAmount: 45_000,
  companyName: 'ЗАО «Василёк»',
  dealCategoryName: 'Сервис',
  responsibleName: 'Петрова Мария'
} as const

/**
 * Второй демо-опрос — ОПУБЛИКОВАННЫЙ, НО БЕЗ ОТВЕТОВ.
 *
 * Нужен ровно для одного: чтобы состояние «ответов меньше порога» можно было увидеть глазами и
 * поставить под визуальный гейт. Раньше оно не воспроизводилось на демо-данных вовсе (12 ответов при
 * пороге 5), и его текст правился вслепую — то есть не правился, а откладывался.
 *
 * Ответов намеренно НЕТ ни одного: так набор остаётся детерминированным, все агрегаты и `pnpm verify`
 * считаются ровно по прежним 12 ответам, а состояние при этом достижимо. И это не искусственная
 * ситуация — только что опубликованный опрос выглядит именно так.
 *
 * ⚠️ **В боевую базу он не уезжает.** Тем же сидом засевается пустая прод-БД (`seedDemoIfEmpty`), и
 * лишний опрос там был бы не фикстурой, а продуктом: живой публичный маршрут `/s/nps_quarterly`,
 * принимающий анонимные ответы, плюс вторая строка в списке админки. Мотив правки — эталон, поэтому
 * опрос добавляется только при демо-сборке в память (`buildDemo()` без стора).
 */
export const EMPTY_SURVEY_KEY = 'nps_quarterly'
export const NPS_Q = 'q_nps'
export const CSAT_Q = 'q_csat'
export const LIKED_Q = 'q_liked'
export const COMMENT_Q = 'q_comment'

export const PRODUCT_NAMES: Record<number, string> = { 1001: 'Внедрение', 1002: 'Поддержка' }
export const CATEGORY_NAMES: Record<number, string> = { 1: 'Продажи', 2: 'Сервис' }
export const RESPONSIBLE_NAMES: Record<number, string> = { 11: 'Иванов', 12: 'Петров', 13: 'Сидорова' }
export const COMPANY_NAMES: Record<number, string> = { 101: 'ООО Ромашка', 102: 'ИП Сидоров' }

function scaleOptions(from: number, to: number): Option[] {
  const out: Option[] = []
  for (let i = from; i <= to; i++) out.push({ key: `n${i}`, label: String(i), score: i })
  return out
}
function csatOptions(): Option[] {
  return [1, 2, 3, 4, 5].map((i) => ({ key: `s${i}`, label: String(i), score: i }))
}

const LIKED_V1: Option[] = [
  { key: 'speed', label: 'Скорость' },
  { key: 'price', label: 'Цена' },
  { key: 'support', label: 'Поддержка' },
  { key: 'quality', label: 'Качество' },
  { key: 'other', label: 'Другое', isOther: true }
]
const LIKED_V2: Option[] = [
  { key: 'speed', label: 'Скорость' },
  { key: 'price', label: 'Цена' },
  { key: 'support', label: 'Поддержка' },
  { key: 'quality', label: 'Качество' },
  { key: 'design', label: 'Дизайн' },
  { key: 'other', label: 'Другое', isOther: true }
]

export function draftV1(): SurveyDraft {
  return {
    surveyKey: SURVEY_KEY,
    title: 'Постпродажный опрос',
    lang: 'ru',
    // Презентация (version-frozen, #25) — контент экранов контура A для Vue-слоя.
    intro: {
      kicker: 'Опрос · 2 минуты',
      title: 'Как прошла работа?',
      lead: 'Пара коротких вопросов о завершённой услуге — ваш ответ помогает нам стать лучше.',
      meta: ['Анонимно', '~2 минуты'],
      cta: 'Начать',
      count: '4 вопроса'
    },
    thanks: {
      title: 'Спасибо за ответы!',
      body: 'Мы учтём вашу оценку — это напрямую влияет на качество услуг.',
      note: 'Окно можно закрыть.'
    },
    questions: [
      { key: NPS_Q, type: 'single', metric: 'nps', required: true, text: 'Насколько вероятно порекомендуете нас?', options: scaleOptions(0, 10) },
      { key: CSAT_Q, type: 'single', metric: 'csat', required: true, text: 'Оцените качество услуги', options: csatOptions() },
      { key: LIKED_Q, type: 'multi', metric: 'choice', required: true, columns: 2, text: 'Что понравилось?', options: LIKED_V1 },
      { key: COMMENT_Q, type: 'text', metric: 'text', required: false, text: 'Комментарий', options: [] }
    ]
  }
}

/** v2: правка текста CSAT (тот же key → класс «text») и новый вариант design (класс «options»). */
export function draftV2(): SurveyDraft {
  const base = draftV1()
  return {
    ...base,
    questions: base.questions.map((q) => {
      if (q.key === CSAT_Q) return { ...q, text: 'Оцените качество оказанной услуги' }
      if (q.key === LIKED_Q) return { ...q, options: LIKED_V2 }
      return q
    })
  }
}

interface SeedEntry {
  v: 1 | 2
  date: string
  companyId: number
  dealCategoryId: number
  responsibleId: number
  products: number[]
  nps: number
  csat: number
  liked: string[]
  likedOther?: string
  comment?: string
}

const SEED: SeedEntry[] = [
  { v: 1, date: '2026-04-03', companyId: 101, dealCategoryId: 1, responsibleId: 11, products: [1001], nps: 10, csat: 5, liked: ['speed', 'quality'], comment: 'Отлично' },
  { v: 1, date: '2026-04-05', companyId: 101, dealCategoryId: 1, responsibleId: 11, products: [1001], nps: 9, csat: 4, liked: ['support'] },
  { v: 1, date: '2026-04-10', companyId: 102, dealCategoryId: 1, responsibleId: 12, products: [1002], nps: 6, csat: 3, liked: ['price', 'other'], likedOther: 'дёшево', comment: 'Можно лучше' },
  { v: 1, date: '2026-04-15', companyId: 102, dealCategoryId: 2, responsibleId: 12, products: [1002], nps: 3, csat: 2, liked: ['support'], comment: 'Долго ждал' },
  { v: 1, date: '2026-04-20', companyId: 101, dealCategoryId: 2, responsibleId: 13, products: [1001, 1002], nps: 8, csat: 4, liked: ['quality'] },
  { v: 1, date: '2026-04-28', companyId: 102, dealCategoryId: 1, responsibleId: 11, products: [1001], nps: 10, csat: 5, liked: ['speed'], comment: 'Супер' },
  { v: 2, date: '2026-05-02', companyId: 101, dealCategoryId: 1, responsibleId: 11, products: [1001], nps: 9, csat: 5, liked: ['speed', 'design'], comment: 'Норм' },
  { v: 2, date: '2026-05-06', companyId: 102, dealCategoryId: 2, responsibleId: 12, products: [1002], nps: 5, csat: 2, liked: ['support'], comment: 'Сложно' },
  { v: 2, date: '2026-05-09', companyId: 101, dealCategoryId: 1, responsibleId: 13, products: [1001], nps: 10, csat: 5, liked: ['quality', 'design'] },
  { v: 2, date: '2026-05-14', companyId: 102, dealCategoryId: 1, responsibleId: 12, products: [1002], nps: 7, csat: 3, liked: ['price'] },
  { v: 2, date: '2026-05-20', companyId: 101, dealCategoryId: 2, responsibleId: 13, products: [1001, 1002], nps: 8, csat: 4, liked: ['support', 'quality'], comment: 'Ок' },
  { v: 2, date: '2026-05-25', companyId: 102, dealCategoryId: 1, responsibleId: 11, products: [1001], nps: 4, csat: 2, liked: ['other'], likedOther: 'ничего', comment: 'Плохо' }
]

function rawFor(e: SeedEntry): Record<string, RawAnswer> {
  return {
    [NPS_Q]: { values: [`n${e.nps}`] },
    [CSAT_Q]: { values: [`s${e.csat}`] },
    [LIKED_Q]: { values: e.liked, text: e.likedOther },
    [COMMENT_Q]: { text: e.comment }
  }
}

/**
 * Строит хранилище с двумя версиями и сидовыми ответами через реальный пайплайн.
 *
 * Пустой второй опрос добавляется ТОЛЬКО в демо-сборку в память: в переданный стор (боевая пустая БД,
 * тесты паритета) он не идёт — там это был бы продукт, а не фикстура. См. {@link EMPTY_SURVEY_KEY}.
 */
export async function buildDemo(): Promise<MemoryStore>
/** То же, но в переданный стор — для тестов паритета реализаций (MemoryStore vs PgStore). */
export async function buildDemo<T extends IStore>(store: T): Promise<T>
export async function buildDemo(store?: IStore): Promise<IStore> {
  const target = store ?? new MemoryStore()
  await target.publish(draftV1(), 1)
  await target.publish(draftV2(), 2)
  if (store === undefined) await target.publish(emptyDraft(), 1)

  for (const [idx, e] of SEED.entries()) {
    const version = await target.getVersion(SURVEY_KEY, e.v)
    if (!version) throw new Error(`Версия ${e.v} не найдена`)
    const { answers } = buildResponseAnswers(version.questions, rawFor(e))
    await target.addResponse({
      id: `r${idx + 1}`,
      surveyKey: SURVEY_KEY,
      versionNo: e.v,
      submittedAt: `${e.date}T10:00:00.000Z`,
      context: {
        dealId: 5000 + idx + 1,
        companyId: e.companyId,
        companyName: COMPANY_NAMES[e.companyId] ?? `#${e.companyId}`,
        dealCategoryId: e.dealCategoryId,
        dealCategoryName: CATEGORY_NAMES[e.dealCategoryId] ?? `#${e.dealCategoryId}`,
        responsibleId: e.responsibleId,
        responsibleName: RESPONSIBLE_NAMES[e.responsibleId] ?? `#${e.responsibleId}`,
        products: e.products.map((productId) => ({ productId, productName: PRODUCT_NAMES[productId] ?? `#${productId}` }))
      },
      answers
    })
  }

  return target
}

/**
 * Черновик второго опроса — только чтобы существовало опубликованное, но пустое. Вопросов минимум:
 * содержание тут ни на что не влияет, экран всё равно подавлен порогом анонимности.
 */
export function emptyDraft(): SurveyDraft {
  return {
    surveyKey: EMPTY_SURVEY_KEY,
    title: 'Ежеквартальный NPS',
    lang: 'ru',
    intro: {
      kicker: 'Опрос · 1 минута',
      title: 'Порекомендуете нас коллегам?',
      lead: 'Один вопрос — и мы поймём, куда двигаться дальше.',
      meta: ['Анонимно', '~1 минута'],
      cta: 'Начать',
      count: '1 вопрос'
    },
    questions: [
      {
        // СВОЙ ключ, не общий `q_nps`: агрегаты (`verify`, тесты) считают по всем ответам стора, и
        // одинаковый ключ означал бы, что первый же ответ на этот опрос молча вольётся в цифры
        // постпродажного.
        key: 'q_nps_quarterly',
        text: 'Насколько вероятно, что вы порекомендуете нас коллегам?',
        type: 'single',
        metric: 'nps',
        required: true,
        options: scaleOptions(0, 10)
      }
    ]
  }
}
