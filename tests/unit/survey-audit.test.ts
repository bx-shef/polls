import { describe, expect, it } from 'vitest'
// Инструмент владельца на чистом JS: типов у него нет и не будет — он переносится
// в другие проекты одним файлом. Форма отчёта описана ниже, ровно в нужном объёме.
import { audit as auditUntyped, bucketBounds as boundsUntyped } from '../../tools/survey-audit/survey-audit.mjs'

/**
 * ⚠ Форма отчёта описана ЗДЕСЬ, а не выведена из модуля, и намеренно неполно: тесту нужны
 * ровно те поля, которые он проверяет. Инструмент — переносимый `.mjs` без типов, и городить
 * ради него декларации значит завести вторую копию его устройства, которая разойдётся
 * с первой при первой же правке.
 */
interface AuditQuestion {
  survey: string
  question: string
  scale: { min: number, max: number, assumed: boolean, mixed: boolean }
  topShare: number | null
  verdict: string
  why: string
}

interface AuditReport {
  distribution: {
    n: number
    avg: number
    buckets: { top: string, mid: string, bottom: string } | null
    shares: { top: number, mid: number, bottom: number } | null
    bucketsSkipped: string | null
  }
  questions: AuditQuestion[]
}

const audit = auditUntyped as (
  input: { answers: unknown[], invitations?: unknown[] },
  overrides?: Record<string, number>,
) => AuditReport
const bucketBounds = boundsUntyped as (min: number, max: number) => { bottom: number, top: number } | null

/**
 * Два дефекта в расчёте корзин (issue #3), найденные `/code-review` на панели PR #1.
 *
 * ⚠ `tools/survey-audit` — отдельный переносимый артефакт владельца, а не код приложения,
 * и тестов у него не было вовсе. Завести их стоит ровно по этой причине: инструмент
 * выдаёт ОТЧЁТ, по которому принимают решения о том, какие вопросы выбрасывать из анкеты.
 * Ошибка в нём не падает, а выглядит правдоподобным числом.
 */

/** Ответы одной группы: один опрос, один вопрос, заданная шкала. */
function answers(values: number[], scale?: { min?: number, max?: number }) {
  return values.map((value, index) => ({
    survey: 's',
    question: 'q',
    type: 'scale' as const,
    value,
    ...(scale?.min === undefined ? {} : { scaleMin: scale.min }),
    ...(scale?.max === undefined ? {} : { scaleMax: scale.max }),
    responseId: `r${index}`,
  }))
}

describe('границы корзин', () => {
  it('на 0–10 остаются NPS-подобными', () => {
    // Разбор старого решения держится на этой шкале: верх 9–10, середина 7–8, низ 0–6.
    // Правка коротких шкал не имела права её тронуть.
    expect(bucketBounds(0, 10)).toEqual({ bottom: 6, top: 9 })
  })

  it('ГЛАВНОЕ: на короткой шкале корзины НЕ СМЫКАЮТСЯ', () => {
    // ⚠ Прежняя формула на 1–3 давала `bottom = top = 2`: значение 2 попадало и в верхнюю
    // корзину, и в нижнюю. Следствия — `inMid` в минусе, сумма долей больше единицы
    // и подпись средней корзины «3–1». На данных заказчика (шкала 0–10) это не всплывало,
    // а «один из списка» с тремя вариантами обсуждается прямо сейчас.
    const short = bucketBounds(1, 3)!

    expect(short.bottom).toBeLessThan(short.top)
    // Между корзинами обязано остаться хотя бы одно значение — иначе середина пуста.
    expect(short.top - short.bottom).toBeGreaterThanOrEqual(2)
  })

  it('и на пятибалльной тоже: там середина оказывалась пустой', () => {
    // 1–5 прежняя формула давала `bottom = 3, top = 4`, то есть середину «4–3»: подпись
    // задом наперёд и ноль ответов в ней при любых данных.
    const five = bucketBounds(1, 5)!

    expect(five.top - five.bottom).toBeGreaterThanOrEqual(2)
  })

  it('шкала короче трёх делений — честный отказ, а не выдуманные корзины', () => {
    // Делить нечего: между «низом» и «верхом» не остаётся ни одного значения.
    expect(bucketBounds(1, 2)).toBeNull()
    expect(bucketBounds(0, 0)).toBeNull()
  })
})

describe('отчёт на короткой шкале', () => {
  const report = audit({ answers: answers([1, 2, 3, 3, 3, 2, 1, 3, 3, 2], { min: 1, max: 3 }) })

  it('доли по корзинам сходятся в единицу', () => {
    // ⚠ То самое, что ломалось: при пересечении корзин сумма долей превышала единицу,
    // и отчёт выглядел правдоподобно ровно до того момента, как их сложат.
    const shares = report.distribution.shares!

    expect(shares.top + shares.mid + shares.bottom).toBeCloseTo(1, 5)
  })

  it('подписи корзин читаются слева направо', () => {
    // Прежняя редакция рендерила середину как «3–1».
    expect(report.distribution.buckets).toEqual({ top: '3–3', mid: '2–2', bottom: '1–1' })
  })
})

describe('отчёт на шкале из двух делений', () => {
  const report = audit({ answers: answers([1, 2, 2, 1, 2], { min: 1, max: 2 }) })

  it('корзин нет, и отчёт говорит об этом словами', () => {
    expect(report.distribution.buckets).toBeNull()
    expect(report.distribution.shares).toBeNull()
    expect(String(report.distribution.bucketsSkipped)).toContain('короче трёх делений')
  })

  it('гистограмма и среднее при этом остаются', () => {
    // Они осмысленны на любой шкале, и терять их из-за корзин незачем.
    expect(report.distribution.n).toBe(5)
    expect(report.distribution.avg).toBeCloseTo(1.6, 5)
  })
})

describe('шкала группы', () => {
  it('ГЛАВНОЕ: берётся по всем строкам, а не из первой', () => {
    // ⚠ Прежняя редакция читала `rows[0].scaleMin ?? 0`. Если у первой строки границ нет,
    // молча подставлялось 0–10 — и вопрос считался по ЧУЖОЙ шкале: вердикты `ritual`
    // и `unanswerable` он уже никогда не получал. Отчёт при этом выглядел нормальным.
    const rows = [
      { ...answers([5])[0]!, scaleMin: undefined, scaleMax: undefined },
      ...answers([5, 5, 5, 4, 5, 5, 5, 5, 5], { min: 1, max: 5 }),
    ]

    const question = audit({ answers: rows }, { minN: 5 }).questions[0]!

    expect(question.scale).toMatchObject({ min: 1, max: 5, assumed: false })
    // По своей шкале вопрос ритуальный: почти все ответы в верхней корзине. По чужой
    // 0–10 верхняя корзина начиналась бы с девятки, и вердикт был бы «работает».
    expect(question.verdict).toBe('ritual')
  })

  it('когда границ нет ни у кого — говорит, что догадался', () => {
    const question = audit({ answers: answers([9, 10, 10, 9, 10]) }, { minN: 5 }).questions[0]!

    expect(question.scale).toMatchObject({ min: 0, max: 10, assumed: true })
    expect(question.why).toContain('не заданы')
  })

  it('когда строки разошлись — говорит и об этом', () => {
    // ⚠ Расхождение внутри группы значит, что анкету правили между прохождениями.
    // Выбрать молча одну из шкал — это и есть тот правдоподобный отчёт, который нельзя
    // перепроверить.
    const rows = [...answers([3, 4, 5], { min: 1, max: 5 }), ...answers([7, 8, 9], { min: 1, max: 10 })]

    const question = audit({ answers: rows }, { minN: 3 }).questions[0]!

    expect(question.scale).toMatchObject({ min: 1, max: 10, mixed: true })
    expect(question.why).toContain('РАЗНЫЕ границы')
  })
})
