import { describe, expect, it } from 'vitest'
import { checkAnswers, MAX_TEXT_BYTES } from '../../server/domain/surveys/answer'
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

  it('строка из пробелов в балльном вопросе не становится честным нулём', () => {
    // Гвард от дефекта, найденного панелью ревью PR #15: без `trim` строка из пробелов
    // доходила до `Number(' ')`, а это ноль. Пропуск молча превращался в оценку «0» —
    // ровно та путаница, отличить которую потом уже нельзя.
    const check = checkAnswers(TEMPLATE, { Q1: '   ', T1: '\n\t ' })

    expect(check.ok && check.answers.Q1).toBe(null)
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
