import { describe, expect, it } from 'vitest'
import { checkAnswers, MAX_TEXT_BYTES, sectionScore } from '../../server/domain/surveys/answer'
import type { SurveyTemplate } from '../../server/domain/surveys/model'

/**
 * Единственное место между посторонним человеком и нашей базой. Плюс формула балла,
 * перенесённая из источника один в один: если она разойдётся, сверка в задаче 6 не сойдётся
 * никогда, и «один в один» клиенту обещать будет нечем.
 */

const TEMPLATE: SurveyTemplate = {
  code: 'brand',
  title: 'Бренд-платформа',
  sections: [
    {
      key: 'product',
      title: 'Продукт',
      scored: true,
      bands: [],
      questions: [
        { key: 'Q1', sourceKey: 'Q1', title: 'Первый', type: 'scale', weight: 30, scored: true, scale: { min: 0, max: 10 } },
        { key: 'Q2', sourceKey: 'Q2', title: 'Второй', type: 'scale', weight: 70, scored: true, scale: { min: 0, max: 10 } },
        { key: 'Q3', sourceKey: 'Q3', title: 'Выключен', type: 'scale', weight: 0, scored: false, scale: { min: 0, max: 10 } },
      ],
    },
    {
      key: 'open',
      title: 'Вопросы',
      scored: false,
      bands: [],
      questions: [{ key: 'T1', sourceKey: 'T1', title: 'Что понравилось', type: 'text', weight: 0, scored: false }],
    },
  ],
}

describe('проверка присланных ответов', () => {
  it('принимает заполненную анкету', () => {
    const check = checkAnswers(TEMPLATE, { Q1: 8, Q2: 9, Q3: 5, T1: 'всё понравилось' })

    expect(check).toEqual({ ok: true, answers: { Q1: 8, Q2: 9, Q3: 5, T1: 'всё понравилось' } })
  })

  it('нетронутый вопрос уезжает как null, а не как ноль', () => {
    // Инвариант проекта и главный урок из данных заказчика: «поставил ноль» и «не тронул
    // ползунок» в его базе — одно и то же значение, и починить это уже нельзя.
    const check = checkAnswers(TEMPLATE, { Q1: 0 })

    expect(check).toEqual({ ok: true, answers: { Q1: 0, Q2: null, Q3: null, T1: null } })
  })

  it('пустой текст — это пропуск, а не ответ длиной ноль', () => {
    const check = checkAnswers(TEMPLATE, { T1: '' })

    expect(check.ok && check.answers.T1).toBe(null)
  })

  it('принимает число, присланное строкой', () => {
    // Форма отправляет значение ползунка строкой; отказывать по типу значило бы
    // ломать анкету на ровном месте.
    const check = checkAnswers(TEMPLATE, { Q1: '7' })

    expect(check.ok && check.answers.Q1).toBe(7)
  })

  it('отвергает оценку вне шкалы', () => {
    const check = checkAnswers(TEMPLATE, { Q1: 11 })

    expect(check.ok).toBe(false)
    expect(!check.ok && check.problems[0]).toMatchObject({ key: 'Q1', code: 'out-of-range' })
  })

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY], [{}], [[]], [true]])(
    'отвергает негодную оценку (%#)',
    (value) => {
      expect(checkAnswers(TEMPLATE, { Q1: value }).ok).toBe(false)
    },
  )

  it('отвергает ответ на вопрос, которого в анкете нет', () => {
    // Либо подделанная форма, либо шаблон подменился между показом и отправкой.
    // Тихо выбросить ключ значило бы записать неполный ответ под видом полного.
    const check = checkAnswers(TEMPLATE, { Q1: 5, ЧУЖОЙ: 1 })

    expect(check.ok).toBe(false)
    expect(!check.ok && check.problems[0]).toMatchObject({ key: 'ЧУЖОЙ', code: 'unknown-question' })
  })

  it('меряет длину текста в байтах, а не в символах', () => {
    // Кириллица в UTF-8 весит вдвое: предел в символах пустил бы вдвое больше данных.
    const cyrillic = 'я'.repeat(MAX_TEXT_BYTES / 2)
    const tooLong = 'я'.repeat(MAX_TEXT_BYTES / 2 + 1)

    expect(checkAnswers(TEMPLATE, { T1: cyrillic }).ok).toBe(true)
    expect(checkAnswers(TEMPLATE, { T1: tooLong }).ok).toBe(false)
  })

  it.each([[null], ['строка'], [[1, 2]], [42]])('отвергает тело, которое не объект (%#)', (body) => {
    expect(checkAnswers(TEMPLATE, body).ok).toBe(false)
  })
})

describe('балл секции', () => {
  it('считает по формуле источника', () => {
    // 8 × 30/100 + 9 × 70/100 = 2.4 + 6.3 = 8.7
    expect(sectionScore(TEMPLATE, 'product', { Q1: 8, Q2: 9 })).toBe(8.7)
  })

  it('округляет до двух знаков, а не до целого', () => {
    // Гвард от того же дефекта, что и PRECISION у поля на портале: балл 7,5 не должен
    // превращаться в 8.
    expect(sectionScore(TEMPLATE, 'product', { Q1: 7, Q2: 7.5 })).toBe(7.35)
  })

  it('не считает вопрос, выключенный из оценки', () => {
    // У Q3 вес 0 и scored: false — его значение на балл не влияет никак.
    expect(sectionScore(TEMPLATE, 'product', { Q1: 10, Q2: 10, Q3: 0 })).toBe(10)
  })

  it('неотвеченный вопрос не добавляет к сумме ничего', () => {
    // То же, что делал источник: там пропуск считался нулём, а ноль на вес даёт ноль.
    // Значит на сверке баллов расхождения не будет.
    expect(sectionScore(TEMPLATE, 'product', { Q1: 10 })).toBe(3)
  })

  it('секция без единого ответа даёт null, а не ноль', () => {
    // Ноль означал бы худшую оценку там, где оценки просто нет, — та же ошибка,
    // что предустановленное значение у ползунка.
    expect(sectionScore(TEMPLATE, 'product', {})).toBe(null)
    expect(sectionScore(TEMPLATE, 'product', { Q1: null, Q2: null })).toBe(null)
  })

  it('не считает балл по секции открытых вопросов', () => {
    expect(sectionScore(TEMPLATE, 'open', { T1: 'текст' })).toBe(null)
  })

  it('не падает на несуществующей секции', () => {
    expect(sectionScore(TEMPLATE, 'нет такой', {})).toBe(null)
  })
})
