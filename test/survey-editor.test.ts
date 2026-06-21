import { describe, it, expect } from 'vitest'
import {
  collectKeys,
  uniqueKey,
  addQuestion,
  addOption,
  moveItem,
  structureErrors,
  normalizeForPublish,
  type EditorQuestion
} from '../src/client/survey-editor'

const q = (over: Partial<EditorQuestion> = {}): EditorQuestion => ({
  key: 'q_x',
  type: 'single',
  metric: 'choice',
  required: true,
  text: '',
  options: [],
  ...over
})

describe('collectKeys', () => {
  it('собирает ключи вопросов и опций', () => {
    const keys = collectKeys([q({ key: 'q1', options: [{ key: 'o1', label: 'a' }, { key: 'o2', label: 'b' }] })])
    expect([...keys].sort()).toEqual(['o1', 'o2', 'q1'])
  })
})

describe('collectKeys', () => {
  it('пустой массив → пустой Set', () => {
    expect(collectKeys([]).size).toBe(0)
  })
})

describe('uniqueKey', () => {
  it('возвращает наименьший свободный prefix_N', () => {
    expect(uniqueKey('q', new Set())).toBe('q_1')
    expect(uniqueKey('q', new Set(['q_1', 'q_2']))).toBe('q_3')
  })
  it('перескакивает занятые в середине', () => {
    expect(uniqueKey('o', new Set(['o_1', 'o_3']))).toBe('o_2')
  })
  it('не коллизит с семантическими ключами', () => {
    expect(uniqueKey('q', new Set(['q_csat', 'q_nps']))).toBe('q_1')
  })
})

describe('addQuestion', () => {
  it('добавляет вопрос с дефолтами и уникальным ключом', () => {
    const qs = [q({ key: 'q_1' })]
    addQuestion(qs)
    expect(qs).toHaveLength(2)
    expect(qs[1]).toMatchObject({ key: 'q_2', type: 'single', metric: 'choice', required: true, text: '', options: [] })
  })
  it('на пустом списке даёт q_1', () => {
    const qs: EditorQuestion[] = []
    addQuestion(qs)
    expect(qs[0]!.key).toBe('q_1')
  })
})

describe('addOption', () => {
  it('добавляет пустую опцию с уникальным ключом', () => {
    const qs = [q({ key: 'q_1', options: [{ key: 'o_1', label: 'a' }] })]
    addOption(qs, 0)
    expect(qs[0]!.options).toHaveLength(2)
    expect(qs[0]!.options[1]).toMatchObject({ key: 'o_2', label: '', score: null })
  })
  it('no-op при неверном индексе', () => {
    const qs = [q()]
    addOption(qs, 5)
    expect(qs[0]!.options).toHaveLength(0)
  })
})

describe('moveItem', () => {
  it('двигает вниз и вверх', () => {
    const a = [1, 2, 3]
    moveItem(a, 0, 1)
    expect(a).toEqual([2, 1, 3])
    moveItem(a, 2, -1)
    expect(a).toEqual([2, 3, 1])
  })
  it('no-op на краях', () => {
    const a = [1, 2, 3]
    moveItem(a, 0, -1)
    moveItem(a, 2, 1)
    expect(a).toEqual([1, 2, 3])
  })
})

describe('structureErrors', () => {
  it('пустой список вопросов', () => {
    expect(structureErrors([])).toEqual(['Добавьте хотя бы один вопрос.'])
  })
  it('вопрос с выбором без опций', () => {
    const errs = structureErrors([q({ type: 'single', options: [] }), q({ type: 'multi', options: [] })])
    expect(errs).toHaveLength(2)
    expect(errs[0]).toContain('Вопрос 1')
    expect(errs[1]).toContain('Вопрос 2')
  })
  it('текстовый вопрос без опций — валиден', () => {
    expect(structureErrors([q({ type: 'text', options: [] })])).toEqual([])
  })
  it('смешанный кейс: текст ок + single без опций → ровно 1 ошибка на вопрос 2', () => {
    const errs = structureErrors([q({ type: 'text', options: [] }), q({ type: 'single', options: [] })])
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain('Вопрос 2')
  })
  it('вопрос с выбором и опцией — валиден', () => {
    expect(structureErrors([q({ type: 'single', options: [{ key: 'o_1', label: 'a' }] })])).toEqual([])
  })
})

describe('normalizeForPublish', () => {
  it('текстовый вопрос → опции очищены', () => {
    const out = normalizeForPublish([q({ type: 'text', options: [{ key: 'o_1', label: 'осталось' }] })])
    expect(out[0]!.options).toEqual([])
  })
  it('score null → undefined', () => {
    const out = normalizeForPublish([q({ type: 'single', options: [{ key: 'o_1', label: 'a', score: null }] })])
    expect(out[0]!.options[0]!.score).toBeUndefined()
  })
  it('score число сохраняется', () => {
    const out = normalizeForPublish([q({ type: 'single', options: [{ key: 'o_1', label: 'a', score: 5 }] })])
    expect(out[0]!.options[0]!.score).toBe(5)
  })
  it('не мутирует исходный массив', () => {
    const qs = [q({ type: 'text', options: [{ key: 'o_1', label: 'a' }] })]
    normalizeForPublish(qs)
    expect(qs[0]!.options).toHaveLength(1)
  })
})
