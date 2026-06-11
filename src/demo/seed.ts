import { buildResponseAnswers } from '../domain/answers'
import { MemoryStore } from '../store/memory'
import type { Option, RawAnswer, SurveyDraft } from '../domain/schema'

/**
 * Детерминированный демо-набор: один опрос, две версии (с правкой текста и
 * добавленным вариантом) и 12 ответов с разным CRM-контекстом. Общий для
 * `pnpm verify` и тестов, поэтому итог воспроизводим.
 */

export const SURVEY_KEY = 'csat_postdeal'
export const NPS_Q = 'q_nps'
export const CSAT_Q = 'q_csat'
export const LIKED_Q = 'q_liked'
export const COMMENT_Q = 'q_comment'

export const PRODUCT_NAMES: Record<number, string> = { 1001: 'Внедрение', 1002: 'Поддержка' }
export const CATEGORY_NAMES: Record<number, string> = { 1: 'Продажи', 2: 'Сервис' }
export const RESPONSIBLE_NAMES: Record<number, string> = { 11: 'Иванов', 12: 'Петров', 13: 'Сидорова' }

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

/** Строит хранилище с двумя версиями и сидовыми ответами через реальный пайплайн. */
export async function buildDemo(): Promise<MemoryStore> {
  const store = new MemoryStore()
  await store.publish(draftV1(), 1)
  await store.publish(draftV2(), 2)

  for (const [idx, e] of SEED.entries()) {
    const version = await store.getVersion(SURVEY_KEY, e.v)
    if (!version) throw new Error(`Версия ${e.v} не найдена`)
    const { answers } = buildResponseAnswers(version.questions, rawFor(e))
    await store.addResponse({
      id: `r${idx + 1}`,
      surveyKey: SURVEY_KEY,
      versionNo: e.v,
      submittedAt: `${e.date}T10:00:00.000Z`,
      context: {
        dealId: 5000 + idx + 1,
        companyId: e.companyId,
        dealCategoryId: e.dealCategoryId,
        responsibleId: e.responsibleId,
        products: e.products.map((productId) => ({ productId, productName: PRODUCT_NAMES[productId] ?? `#${productId}` }))
      },
      answers
    })
  }

  return store
}
