import { describe, expect, it } from 'vitest'
import type { SurveyTemplate } from '../../server/domain/surveys/model'
import {
  NO_ANSWER,
  asScore,
  buildResultSections,
  readAnswersField,
  readScoresField,
  showAnswer,
} from '../../server/domain/surveys/result-view'

/**
 * Результат опроса в виджете карточки: что увидит менеджер вместо двух простыней JSON.
 *
 * Главное здесь — ноль и пропуск. Проект уже горел на том, что «поставил ноль» и «не тронул»
 * стали одним значением; показ — последнее место, где это различие можно потерять.
 */

const TEMPLATE: SurveyTemplate = {
  code: 'brand',
  title: 'Бренд',
  sections: [
    {
      key: 'product',
      title: 'Продукт',
      scored: true,
      bands: [],
      questions: [
        { key: 'q1', sourceKey: 'q1', title: 'Качество', type: 'scale', weight: 1, scored: true, scale: { min: 0, max: 10 } },
        { key: 'q2', sourceKey: 'q2', title: 'Сроки', type: 'scale', weight: 1, scored: true, scale: { min: 0, max: 10 } },
      ],
    },
    {
      key: 'open',
      title: 'Открытые вопросы',
      scored: false,
      bands: [],
      questions: [
        { key: 'q3', sourceKey: 'q3', title: 'Что улучшить?', type: 'text', weight: 0, scored: false },
        { key: 'q4', sourceKey: 'q4', title: 'Когда удобно связаться?', type: 'date', weight: 0, scored: false },
      ],
    },
  ],
}

describe('значение ответа', () => {
  it('ноль остаётся нулём', () => {
    expect(showAnswer(0)).toBe('0')
  })

  it.each<[unknown, string]>([
    [null, 'не ответил'],
    [undefined, 'вопроса не было в ответе'],
    ['', 'пустая строка'],
    ['   ', 'одни пробелы'],
  ])('пропуск — прочерк (%#: %s)', (value) => {
    expect(showAnswer(value)).toBe(NO_ANSWER)
  })
})

describe('балл', () => {
  it('ноль остаётся нулём, строка читается числом', () => {
    expect(asScore(0)).toBe(0)
    expect(asScore('7.5')).toBe(7.5)
  })

  it.each<[unknown, string]>([
    [null, '`Number(null) === 0` — ловушка, на которой проект уже горел'],
    ['', '`Number(\'\') === 0` — та же ловушка'],
    ['abc', 'не число'],
  ])('незаполненный балл — не ноль (%#: %s)', (raw) => {
    expect(asScore(raw)).toBeNull()
  })
})

describe('поля элемента', () => {
  it('читает ответы из JSON-объекта', () => {
    expect(readAnswersField('{"q1":7,"q3":null}')).toEqual({ q1: 7, q3: null })
  })

  it.each<[unknown, string]>([
    ['', 'пусто — приглашение ещё не прошли'],
    ['[1,2]', 'список, а не объект'],
    ['не json', 'испорчено'],
    [null, 'поля нет'],
  ])('без ответов отвечает null (%#: %s)', (raw) => {
    expect(readAnswersField(raw)).toBeNull()
  })

  it('читает баллы разделов и не превращает пропуск в ноль', () => {
    const scores = readScoresField('[{"key":"product","score":0},{"key":"open","score":null},{"score":5}]')

    expect(scores.get('product')).toBe(0)
    expect(scores.get('open')).toBeNull()
    // Строка без ключа пропускается: приписать её некуда.
    expect(scores.size).toBe(2)
  })
})

describe('разделы результата', () => {
  const answers = { q1: 0, q2: null, q3: 'Быстрее отвечать\nи чаще звонить', q4: '2026-10-01' }
  const sections = buildResultSections(TEMPLATE, answers, new Map([['product', 0]]))

  it('показывает вопросы словами, в порядке анкеты', () => {
    expect(sections.map(s => s.title)).toEqual(['Продукт', 'Открытые вопросы'])
    expect(sections[0]!.answers.map(a => a.title)).toEqual(['Качество', 'Сроки'])
  })

  it('оценка ноль — это «0 из 10», а пропуск — прочерк без шкалы', () => {
    const [quality, deadlines] = sections[0]!.answers

    expect([quality!.value, quality!.scale]).toEqual(['0', 'из 10'])
    // «— из 10» читалось бы как оценка, которой не ставили.
    expect([deadlines!.value, deadlines!.scale]).toEqual([NO_ANSWER, ''])
  })

  it('балл раздела ноль остаётся нулём, а раздел без балла — без балла', () => {
    expect(sections[0]!.score).toBe(0)
    expect(sections[1]!.score).toBeNull()
  })

  it('текст отдаёт как есть, дату — по-русски', () => {
    const [text, date] = sections[1]!.answers

    expect(text!.value).toBe('Быстрее отвечать\nи чаще звонить')
    expect(date!.value).toBe('01.10.2026')
  })

  it('без схемы показывает ключи, а не пустоту', () => {
    // Схема пропала и с портала не прочиталась — «ответ был» всё равно должно быть видно.
    const bare = buildResultSections(null, { q1: 7, q3: null }, new Map())

    expect(bare).toHaveLength(1)
    expect(bare[0]!.answers.map(a => [a.title, a.value])).toEqual([['q1', '7'], ['q3', NO_ANSWER]])
  })
})
