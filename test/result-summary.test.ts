import { describe, expect, it } from 'vitest'
import { summarizeResponse, type ResultLine } from '../src/domain/result-summary'
import type { CompiledVersion, Question, ResponseRecord, StoredAnswer } from '../src/domain/schema'

const q = (over: Partial<Question> & { key: string; text: string }): Question => ({
  type: 'single',
  metric: 'scale',
  required: true,
  options: [],
  ...over
})

const version = (questions: Question[]): CompiledVersion => ({
  surveyKey: 's',
  title: 'Опрос',
  lang: 'ru',
  versionNo: 1,
  questions,
  compiledAt: '2026-07-24T10:00:00.000Z'
})

const ans = (over: Partial<StoredAnswer> & { questionKey: string; metric: StoredAnswer['metric'] }): StoredAnswer => ({
  valueChoice: [],
  valueNumber: null,
  valueText: null,
  ...over
})

const response = (answers: StoredAnswer[]): ResponseRecord => ({
  id: 'r1',
  surveyKey: 's',
  versionNo: 1,
  submittedAt: '2026-07-24T10:05:00.000Z',
  context: {},
  answers
})

describe('summarizeResponse — сводка одного ответа (#18)', () => {
  it('числовая метрика → значение как есть; порядок — по вопросам версии', () => {
    const v = version([
      q({ key: 'nps', text: 'Оцените', metric: 'nps' }),
      q({ key: 'csat', text: 'Довольны?', metric: 'csat' })
    ])
    const r = response([
      ans({ questionKey: 'csat', metric: 'csat', valueNumber: 5 }),
      ans({ questionKey: 'nps', metric: 'nps', valueNumber: 9 })
    ])
    expect(summarizeResponse(v, r)).toEqual<ResultLine[]>([
      { label: 'Оцените', value: '9' }, // порядок версии, не ответа
      { label: 'Довольны?', value: '5' }
    ])
  })

  it('choice → метки вариантов через options; неизвестный ключ → сам ключ (fallback)', () => {
    const v = version([
      q({ key: 'ch', text: 'Что понравилось', type: 'multi', metric: 'choice', options: [
        { key: 'a', label: 'Сервис' },
        { key: 'b', label: 'Цена' }
      ] })
    ])
    const r = response([ans({ questionKey: 'ch', metric: 'choice', valueChoice: ['a', 'b', 'gone'] })])
    expect(summarizeResponse(v, r)).toEqual([{ label: 'Что понравилось', value: 'Сервис, Цена, gone' }])
  })

  it('«Другое»: метка варианта + свободный текст клиента (текст не теряем)', () => {
    const v = version([
      q({ key: 'ch', text: 'Что улучшить', type: 'multi', metric: 'choice', options: [
        { key: 'price', label: 'Цена' },
        { key: 'other', label: 'Другое', isOther: true }
      ] })
    ])
    // normalizeAnswer кладёт текст «Другого» в valueText РЯДОМ с ключом опции в valueChoice
    const r = response([ans({ questionKey: 'ch', metric: 'choice', valueChoice: ['other'], valueText: 'быстрее доставка' })])
    expect(summarizeResponse(v, r)).toEqual([{ label: 'Что улучшить', value: 'Другое: быстрее доставка' }])
  })

  it('valueNumber=0 выводится (валиден для nps/ces), не опускается как falsy', () => {
    const v = version([q({ key: 'nps', text: 'Оцените', metric: 'nps' })])
    const r = response([ans({ questionKey: 'nps', metric: 'nps', valueNumber: 0 })])
    expect(summarizeResponse(v, r)).toEqual([{ label: 'Оцените', value: '0' }])
  })

  it('число побеждает при заполненных valueNumber и valueText (precedence)', () => {
    const v = version([q({ key: 'x', text: 'X', metric: 'scale' })])
    const r = response([ans({ questionKey: 'x', metric: 'scale', valueNumber: 7, valueText: 'игнор' })])
    expect(summarizeResponse(v, r)).toEqual([{ label: 'X', value: '7' }])
  })

  it('свободный текст → как есть; кап значения (maxValueLen)', () => {
    const v = version([q({ key: 't', text: 'Комментарий', type: 'text', metric: 'text' })])
    const r = response([ans({ questionKey: 't', metric: 'text', valueText: 'Ы'.repeat(400) })])
    const lines = summarizeResponse(v, r, { maxValueLen: 50 })
    expect(lines[0]!.value.length).toBe(50)
  })

  it('пропущенные/пустые ответы не выводятся (не шумят)', () => {
    const v = version([
      q({ key: 'a', text: 'A', metric: 'nps' }),
      q({ key: 'b', text: 'B', type: 'text', metric: 'text' }),
      q({ key: 'c', text: 'C', metric: 'nps' })
    ])
    // на B — пустой текст, на C — ответа нет вовсе; отвечен только A
    const r = response([
      ans({ questionKey: 'a', metric: 'nps', valueNumber: 8 }),
      ans({ questionKey: 'b', metric: 'text', valueText: '   ' })
    ])
    expect(summarizeResponse(v, r)).toEqual([{ label: 'A', value: '8' }])
  })

  it('maxLines ограничивает число строк', () => {
    const v = version(Array.from({ length: 30 }, (_, i) => q({ key: `q${i}`, text: `Q${i}`, metric: 'nps' })))
    const r = response(Array.from({ length: 30 }, (_, i) => ans({ questionKey: `q${i}`, metric: 'nps', valueNumber: i })))
    expect(summarizeResponse(v, r, { maxLines: 3 })).toHaveLength(3)
    expect(summarizeResponse(v, r)).toHaveLength(15) // дефолт
  })
})
