import { describe, expect, it } from 'vitest'
import { buildResponseAnswers, coerceExclusive, normalizeAnswer, validateAnswer } from '../src/domain/answers'
import type { Question } from '../src/domain/schema'

const npsQ: Question = {
  key: 'q_nps', type: 'single', metric: 'nps', required: true, text: '?',
  options: [
    { key: 'n0', label: '0', score: 0 },
    { key: 'n9', label: '9', score: 9 },
    { key: 'n10', label: '10', score: 10 }
  ]
}

const multiQ: Question = {
  key: 'q_m', type: 'multi', metric: 'choice', required: true, text: '?',
  options: [
    { key: 'a', label: 'A' },
    { key: 'b', label: 'B' },
    { key: 'none', label: 'Ничего', isExclusive: true },
    { key: 'other', label: 'Другое', isOther: true }
  ]
}

const textQ: Question = { key: 'q_t', type: 'text', metric: 'text', required: false, text: '?', options: [] }

describe('normalizeAnswer — числовое значение из score', () => {
  it('single nps → valueNumber из выбранного варианта', () => {
    const a = normalizeAnswer(npsQ, { values: ['n9'] })
    expect(a).toMatchObject({ questionKey: 'q_nps', valueNumber: 9, valueChoice: ['n9'], valueText: null })
  })

  it('single берёт только первый вариант', () => {
    expect(normalizeAnswer(npsQ, { values: ['n9', 'n10'] })?.valueChoice).toEqual(['n9'])
  })

  it('неизвестные ключи отбрасываются → null', () => {
    expect(normalizeAnswer(npsQ, { values: ['zzz'] })).toBeNull()
  })
})

describe('normalizeAnswer — exclusive и other', () => {
  it('exclusive доминирует над остальными', () => {
    expect(coerceExclusive(multiQ, ['a', 'none', 'b'])).toEqual(['none'])
    expect(normalizeAnswer(multiQ, { values: ['a', 'none'] })?.valueChoice).toEqual(['none'])
  })

  it('other-текст сохраняется только при непустом значении', () => {
    expect(normalizeAnswer(multiQ, { values: ['other'], text: '  своё  ' })?.valueText).toBe('своё')
    expect(normalizeAnswer(multiQ, { values: ['other'], text: '   ' })?.valueText).toBeNull()
  })

  it('multi сохраняет несколько вариантов', () => {
    expect(normalizeAnswer(multiQ, { values: ['a', 'b'] })?.valueChoice).toEqual(['a', 'b'])
  })

  it('exclusive вытесняет other — текст «Другое» не сохраняется', () => {
    const a = normalizeAnswer(multiQ, { values: ['none', 'other'], text: 'своё' })
    expect(a?.valueChoice).toEqual(['none'])
    expect(a?.valueText).toBeNull()
  })
})

describe('normalizeAnswer — текстовый вопрос', () => {
  it('тримит и сохраняет текст; пустой → null', () => {
    expect(normalizeAnswer(textQ, { text: ' привет ' })?.valueText).toBe('привет')
    expect(normalizeAnswer(textQ, { text: '' })).toBeNull()
  })
})

describe('validateAnswer', () => {
  it('обязательный без выбора → ошибка', () => {
    expect(validateAnswer(npsQ, {})).toBe('Выберите вариант')
    expect(validateAnswer(multiQ, {})).toBe('Выберите хотя бы один вариант')
  })

  it('обязательный с одними неизвестными ключами → ошибка', () => {
    expect(validateAnswer(npsQ, { values: ['zzz'] })).toBe('Выберите вариант')
  })

  it('необязательный текст без значения → нет ошибки', () => {
    expect(validateAnswer(textQ, {})).toBeNull()
  })

  it('обязательный текст без значения → ошибка', () => {
    expect(validateAnswer({ ...textQ, required: true }, {})).toBe('Заполните поле')
  })
})

describe('buildResponseAnswers', () => {
  it('собирает валидные, пропускает пустые необязательные, копит ошибки', () => {
    const { answers, errors } = buildResponseAnswers([npsQ, multiQ, textQ], {
      q_nps: { values: ['n10'] },
      // q_m пропущен → ошибка (required)
      q_t: {} // необязательный → просто пропуск
    })
    expect(errors).toEqual({ q_m: 'Выберите хотя бы один вариант' })
    expect(answers.map((a) => a.questionKey)).toEqual(['q_nps'])
    expect(answers[0]?.valueNumber).toBe(10)
  })
})
