import { describe, expect, it } from 'vitest'
import { SurveyFill, isAnswered, type SurveyFillSnapshot } from '../src/client/survey-fill'
import type { CompiledVersion, Option, Question } from '../src/domain/schema'

function opt(key: string, extra: Partial<Option> = {}): Option {
  return { key, label: key, ...extra }
}

function mkQ(over: Pick<Question, 'key' | 'type'> & Partial<Question>): Question {
  return {
    key: over.key,
    type: over.type,
    metric: over.metric ?? (over.type === 'text' ? 'text' : 'choice'),
    required: over.required ?? true,
    text: over.text ?? over.key,
    options: over.options ?? [],
    ...(over.block !== undefined ? { block: over.block } : {}),
    ...(over.columns !== undefined ? { columns: over.columns } : {})
  }
}

function ver(questions: Question[]): CompiledVersion {
  return { surveyKey: 'sv', title: 'T', lang: 'ru', versionNo: 1, questions, compiledAt: '2026-06-15T00:00:00.000Z' }
}

// Типовой набор: single с «Другое», multi с exclusive+«Другое», text, необязательный single.
function demoVersion(): CompiledVersion {
  return ver([
    mkQ({ key: 'q1', type: 'single', block: 'A', options: [opt('a'), opt('b'), opt('other', { isOther: true })] }),
    mkQ({
      key: 'q2',
      type: 'multi',
      block: 'A',
      columns: 2,
      options: [opt('x'), opt('y'), opt('none', { isExclusive: true }), opt('other', { isOther: true })]
    }),
    mkQ({ key: 'q3', type: 'text', metric: 'text', block: 'B' }),
    mkQ({ key: 'q4', type: 'single', required: false, block: 'B', options: [opt('m'), opt('n')] })
  ])
}

describe('SurveyFill — инициализация и навигация', () => {
  it('старт: current=0, пустые ответы, первый/не последний', () => {
    const f = new SurveyFill(demoVersion())
    expect(f.state.current).toBe(0)
    expect(f.progress).toEqual({ current: 1, total: 4 })
    expect(f.isFirst).toBe(true)
    expect(f.isLast).toBe(false)
    expect(f.currentBlock).toBe('A')
    expect(f.toSubmission().answers).toEqual({})
  })

  it('«Назад» на первом вопросе — без эффекта', () => {
    const f = new SurveyFill(demoVersion())
    f.back()
    expect(f.state.current).toBe(0)
  })

  it('обязательный вопрос без ответа блокирует «Далее» (showError, остаёмся)', () => {
    const f = new SurveyFill(demoVersion())
    expect(f.next()).toBe(false)
    expect(f.state.current).toBe(0)
    expect(f.state.showError).toBe(true)
  })

  it('ответ снимает ошибку и пускает дальше; back возвращает', () => {
    const f = new SurveyFill(demoVersion())
    f.next() // showError
    f.selectOption('a')
    expect(f.state.showError).toBe(false)
    expect(f.next()).toBe(true)
    expect(f.state.current).toBe(1)
    f.back()
    expect(f.state.current).toBe(0)
    expect(f.currentAnswer.picked).toEqual(['a'])
  })

  it('необязательный вопрос пропускается пустым', () => {
    const f = new SurveyFill(demoVersion())
    f.goTo(3) // q4, required:false
    expect(f.canAdvance).toBe(true)
    expect(f.next()).toBe(true)
  })

  it('goTo клампит индекс в диапазон', () => {
    const f = new SurveyFill(demoVersion())
    f.goTo(99)
    expect(f.state.current).toBe(3)
    f.goTo(-5)
    expect(f.state.current).toBe(0)
  })

  it('last: next() валидирует, но не инкрементит (сигнал «можно отправлять»)', () => {
    const f = new SurveyFill(demoVersion())
    f.goTo(3)
    expect(f.isLast).toBe(true)
    expect(f.next()).toBe(true)
    expect(f.state.current).toBe(3)
  })
})

describe('SurveyFill — выбор single/multi и exclusive', () => {
  it('single заменяет предыдущий выбор', () => {
    const f = new SurveyFill(demoVersion())
    f.selectOption('a')
    f.selectOption('b')
    expect(f.currentAnswer.picked).toEqual(['b'])
  })

  it('multi тоггл: добавление и снятие', () => {
    const f = new SurveyFill(demoVersion())
    f.goTo(1)
    f.selectOption('x')
    f.selectOption('y')
    expect(f.currentAnswer.picked).toEqual(['x', 'y'])
    f.selectOption('x')
    expect(f.currentAnswer.picked).toEqual(['y'])
  })

  it('exclusive: выбор исключающего снимает прочие', () => {
    const f = new SurveyFill(demoVersion())
    f.goTo(1)
    f.selectOption('x')
    f.selectOption('y')
    f.selectOption('none')
    expect(f.currentAnswer.picked).toEqual(['none'])
  })

  it('exclusive: выбор обычного снимает исключающий', () => {
    const f = new SurveyFill(demoVersion())
    f.goTo(1)
    f.selectOption('none')
    f.selectOption('x')
    expect(f.currentAnswer.picked).toEqual(['x'])
  })

  it('exclusive: снятие исключающего — просто убрать', () => {
    const f = new SurveyFill(demoVersion())
    f.goTo(1)
    f.selectOption('none')
    f.selectOption('none')
    expect(f.currentAnswer.picked).toEqual([])
  })

  it('клавиши 1..9 → option_key; вне диапазона/типа → undefined', () => {
    const f = new SurveyFill(demoVersion())
    expect(f.optionKeyByNumber(1)).toBe('a')
    expect(f.optionKeyByNumber(3)).toBe('other')
    expect(f.optionKeyByNumber(4)).toBeUndefined() // у q1 три опции
    expect(f.optionKeyByNumber(0)).toBeUndefined()
    expect(f.optionKeyByNumber(10)).toBeUndefined()
  })
})

describe('SurveyFill — «Другое» и маппинг в submission', () => {
  it('single с «Другое» + текст → values:[other], text', () => {
    const f = new SurveyFill(demoVersion())
    f.selectOption('other')
    f.setOther('  свой вариант  ')
    expect(f.toSubmission().answers.q1).toEqual({ values: ['other'], text: 'свой вариант' })
  })

  it('«Другое» выбран, но текст пуст → только values', () => {
    const f = new SurveyFill(demoVersion())
    f.selectOption('other')
    f.setOther('   ')
    expect(f.toSubmission().answers.q1).toEqual({ values: ['other'] })
  })

  it('текст «Другое» есть, но вариант не выбран → text не уходит', () => {
    const f = new SurveyFill(demoVersion())
    f.setOther('призрак')
    f.selectOption('a')
    expect(f.toSubmission().answers.q1).toEqual({ values: ['a'] })
  })

  it('текст «Другое» сохраняется при снятии и возвращается при повторном выборе', () => {
    const f = new SurveyFill(demoVersion())
    f.goTo(1)
    f.selectOption('other')
    f.setOther('текст')
    f.selectOption('other') // снять
    expect(f.currentAnswer.picked).not.toContain('other')
    expect(f.currentAnswer.other).toBe('текст') // не очищен
    expect(f.toSubmission().answers.q2).toBeUndefined() // ничего не выбрано
    f.selectOption('other') // вернуть
    expect(f.toSubmission().answers.q2).toEqual({ values: ['other'], text: 'текст' })
  })

  it('multi: значения в каноническом порядке опций независимо от кликов', () => {
    const f = new SurveyFill(demoVersion())
    f.goTo(1)
    f.selectOption('other') // индекс 3
    f.selectOption('x') // индекс 0
    expect(f.toSubmission().answers.q2?.values).toEqual(['x', 'other'])
  })

  it('text-вопрос: trim, пустой не уходит', () => {
    const f = new SurveyFill(demoVersion())
    f.goTo(2)
    expect(isAnswered(f.currentQuestion, f.currentAnswer)).toBe(false)
    f.setText('  ответ  ')
    expect(isAnswered(f.currentQuestion, f.currentAnswer)).toBe(true)
    expect(f.toSubmission().answers.q3).toEqual({ text: 'ответ' })
    f.setText('   ')
    expect(f.toSubmission().answers.q3).toBeUndefined()
  })

  it('необязательный пустой вопрос не попадает в submission', () => {
    const f = new SurveyFill(demoVersion())
    f.selectOption('a')
    const sub = f.toSubmission()
    expect(sub.answers.q4).toBeUndefined()
    expect(sub.surveyKey).toBe('sv')
    expect(sub.versionNo).toBe(1)
  })
})

describe('SurveyFill — persist (snapshot/restore)', () => {
  it('snapshot → восстановление: ответы и позиция', () => {
    const f = new SurveyFill(demoVersion())
    f.selectOption('a')
    f.next()
    f.selectOption('x')
    const snap = f.snapshot()
    expect(snap).toMatchObject({ surveyKey: 'sv', versionNo: 1, current: 1 })

    const restored = new SurveyFill(demoVersion(), snap)
    expect(restored.state.current).toBe(1)
    expect(restored.toSubmission().answers).toEqual({ q1: { values: ['a'] }, q2: { values: ['x'] } })
  })

  it('снимок чужой версии игнорируется (старт с нуля)', () => {
    const f = new SurveyFill(demoVersion())
    f.selectOption('a')
    const alien: SurveyFillSnapshot = { ...f.snapshot(), versionNo: 99 }
    const fresh = new SurveyFill(demoVersion(), alien)
    expect(fresh.state.current).toBe(0)
    expect(fresh.toSubmission().answers).toEqual({})
  })

  it('снимок чужого surveyKey игнорируется (старт с нуля)', () => {
    const f = new SurveyFill(demoVersion())
    f.selectOption('a')
    const alien: SurveyFillSnapshot = { ...f.snapshot(), surveyKey: 'other' }
    const fresh = new SurveyFill(demoVersion(), alien)
    expect(fresh.state.current).toBe(0)
    expect(fresh.toSubmission().answers).toEqual({})
  })

  it('deep-link goTo перекрывает позицию снимка, ответы сохраняются', () => {
    const f = new SurveyFill(demoVersion())
    f.selectOption('a')
    f.next() // q2, current=1
    const restored = new SurveyFill(demoVersion(), f.snapshot())
    restored.goTo(0) // deep-link override на q1
    expect(restored.state.current).toBe(0)
    expect(restored.toSubmission().answers).toEqual({ q1: { values: ['a'] } })
  })
})

describe('SurveyFill — доводки ревью (guards, клавиши, restore-hardening)', () => {
  it('клавиша-цифра → тоггл multi, включая exclusive', () => {
    const f = new SurveyFill(demoVersion())
    f.goTo(1) // q2 multi: x(1) y(2) none(3,excl) other(4)
    f.selectOption(f.optionKeyByNumber(1)!)
    f.selectOption(f.optionKeyByNumber(2)!)
    expect(f.currentAnswer.picked).toEqual(['x', 'y'])
    f.selectOption(f.optionKeyByNumber(3)!) // none (exclusive) — снимает прочие
    expect(f.currentAnswer.picked).toEqual(['none'])
  })

  it('повторный клик single — остаётся выбранным (не тоггл)', () => {
    const f = new SurveyFill(demoVersion())
    f.selectOption('a')
    f.selectOption('a')
    expect(f.currentAnswer.picked).toEqual(['a'])
  })

  it('«Другое» + exclusive в multi: exclusive снимает прочие, other-текст сохраняется', () => {
    const f = new SurveyFill(demoVersion())
    f.goTo(1)
    f.selectOption('other')
    f.setOther('txt')
    f.selectOption('x')
    f.selectOption('none') // exclusive
    expect(f.currentAnswer.picked).toEqual(['none'])
    expect(f.currentAnswer.other).toBe('txt')
    expect(f.toSubmission().answers.q2).toEqual({ values: ['none'] }) // text не уходит (other снят)
  })

  it('каноничный порядок values для 3+ выбранных', () => {
    const f = new SurveyFill(demoVersion())
    f.goTo(1)
    f.selectOption('y')
    f.selectOption('other')
    f.selectOption('x')
    expect(f.toSubmission().answers.q2?.values).toEqual(['x', 'y', 'other'])
  })

  it('showError сбрасывается после back', () => {
    const f = new SurveyFill(demoVersion())
    f.selectOption('a')
    f.next() // → q2
    expect(f.next()).toBe(false) // q2 required, пусто → showError
    expect(f.state.showError).toBe(true)
    f.back() // → q1
    expect(f.state.showError).toBe(false)
  })

  it('selectOption на text-вопросе — no-op', () => {
    const f = new SurveyFill(demoVersion())
    f.goTo(2) // q3 text
    f.selectOption('phantom')
    expect(f.currentAnswer.picked).toEqual([])
  })

  it('deep-link goTo(2) открывает третий вопрос', () => {
    const f = new SurveyFill(demoVersion())
    f.goTo(2)
    expect(f.currentQuestion.key).toBe('q3')
  })

  it('версия без вопросов — конструктор бросает', () => {
    expect(() => new SurveyFill(ver([]))).toThrow(/без вопросов/)
  })

  it('restore с частичными ответами: остальные — пустые', () => {
    const snap: SurveyFillSnapshot = {
      surveyKey: 'sv',
      versionNo: 1,
      current: 0,
      answers: { q1: { picked: ['a'], other: '', text: '' } }
    }
    const f = new SurveyFill(demoVersion(), snap)
    expect(f.currentAnswer.picked).toEqual(['a'])
    expect(f.toSubmission().answers).toEqual({ q1: { values: ['a'] } })
  })

  it('restore подделанного снимка (picked не массив) → старт с нуля', () => {
    const bad = {
      surveyKey: 'sv',
      versionNo: 1,
      current: 0,
      answers: { q1: { picked: 'oops', other: '', text: '' } }
    } as unknown as SurveyFillSnapshot
    const f = new SurveyFill(demoVersion(), bad)
    expect(f.state.current).toBe(0)
    expect(f.toSubmission().answers).toEqual({})
  })

  it('restore при превышении лимитов (picked > 200) → снимок отброшен', () => {
    const huge = {
      surveyKey: 'sv',
      versionNo: 1,
      current: 0,
      answers: { q1: { picked: Array.from({ length: 201 }, (_, i) => `k${i}`), other: '', text: '' } }
    } as unknown as SurveyFillSnapshot
    const f = new SurveyFill(demoVersion(), huge)
    expect(f.toSubmission().answers).toEqual({})
  })
})
