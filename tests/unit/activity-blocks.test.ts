import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_BLOCKS_SET_METHOD,
  MAX_LAYOUT_BLOCKS,
  buildActivityBlocksCall,
  buildResultBlocks,
  readBlocksApplied,
  type LayoutBlock,
  type LayoutBlocks,
} from '../../server/domain/answers/activity-blocks'
import type { SurveyTemplate } from '../../server/domain/surveys/model'
import { NO_SCORE_NOTE } from '../../server/domain/surveys/result-view'
import { scoreSurvey } from '../../server/domain/surveys/scoring'

/**
 * Блоки дела с итогом: итоговый балл, баллы разделов и вопросов, ссылка на карточку (#84, п. 6).
 *
 * ⚠ Гварды на баллы переехали сюда из теста текста дела: до п. 6 баллы жили в описании,
 * теперь — в блоках. Замечания владельца, из которых они выросли, те же.
 */

const CARD = { entityTypeId: 1046, itemId: 777 }

const TEMPLATE: SurveyTemplate = {
  code: 'brand',
  title: 'Оценка работы по проекту',
  sections: [
    {
      key: 'product',
      title: 'Продукт',
      scored: true,
      bands: [{ from: 8, to: 10, text: 'Мы на вершине!' }],
      questions: [
        { key: 'P1', sourceKey: 'P1', title: 'Качество результата', type: 'scale', weight: 60, scored: true, scale: { min: 0, max: 10 } },
        { key: 'P2', sourceKey: 'P2', title: 'Соответствие задаче', type: 'scale', weight: 40, scored: true, scale: { min: 0, max: 10 } },
      ],
    },
    {
      key: 'open',
      title: 'Открытые вопросы',
      scored: false,
      bands: [],
      questions: [
        { key: 'T1', sourceKey: 'T1', title: 'Что понравилось', type: 'text', weight: 0, scored: false },
      ],
    },
  ],
}

function blocks(answers: Record<string, number | string | null>, template: SurveyTemplate = TEMPLATE): LayoutBlocks {
  return buildResultBlocks(template, answers, scoreSurvey(template, answers), CARD)
}

/** A row as a person reads it: «подпись: значение», or the plain text of a heading. */
function lines(set: LayoutBlocks): string[] {
  return Object.values(set).map((block) => {
    const props = block.properties as { title?: string, value?: string, text?: string, block?: LayoutBlock }
    if (block.type === 'withTitle') return `${props.title}: ${String((props.block!.properties as { value: string }).value)}`
    return String(props.value ?? props.text)
  })
}

describe('блоки итога', () => {
  it('ГЛАВНОЕ: итог первым и выделен, потом раздел с баллом, потом баллы его вопросов', () => {
    const set = blocks({ P1: 9, P2: 8, T1: 'Всё отлично' })

    // 9×0.6 + 8×0.4 = 8.6
    expect(lines(set)).toEqual([
      'Итоговый балл: 8,6',
      'Продукт: 8,6',
      'Качество результата: 9 из 10',
      'Соответствие задаче: 8 из 10',
      'Разбор анкеты — в карточке опроса',
    ])
    expect((set.total!.properties.block as LayoutBlock).properties).toMatchObject({ bold: true, color: 'base_90' })
  })

  it('показывает балл КАЖДОГО вопроса, а не только раздела', () => {
    // ⚠ Гвард под замечание владельца: «у нас 2 вопроса и 1 комментарий — в деле такого
    // не видно». Первая редакция печатала один агрегат, и менеджер видел «Продукт: 8,6»,
    // не зная, что за ним 9 и 8.
    expect(lines(blocks({ P1: 9, P2: 8 }))).toContain('Качество результата: 9 из 10')
  })

  it('НЕ показывает текст диапазона — он написан для клиента, не для менеджера', () => {
    expect(JSON.stringify(blocks({ P1: 9, P2: 8 }))).not.toContain('Мы на вершине!')
  })

  it('пишет балл русской записью, через запятую', () => {
    const set = JSON.stringify(blocks({ P1: 9, P2: 8 }))

    expect(set).toContain('8,6')
    expect(set).not.toContain('8.6')
  })

  it('называет неполноту словами — пропуск вошёл в балл низшей оценкой', () => {
    // Пропуск считается низшей оценкой (решение владельца 28.09): 9 × 0,6 + 0 × 0,4 = 5,4.
    // Без подписи «клиент недоволен» и «клиент не ответил» дали бы одну и ту же цифру.
    expect(lines(blocks({ P1: 9, P2: null }))).toContain('Продукт: 5,4 (ответ на 1 из 2, пропуск — низшая оценка)')
  })

  it('не приписывает «ответ на N из M», когда ответили на всё', () => {
    expect(lines(blocks({ P1: 9, P2: 8 }))).toContain('Продукт: 8,6')
  })

  it('раздел, где не ответили вовсе, говорит о себе — низшим баллом с подписью', () => {
    // Молчание по целой секции — сигнал, а не пустое место. Пропущенный вопрос строки не даёт:
    // о нём говорит подпись раздела.
    const shown = lines(blocks({ P1: null, P2: null }))

    expect(shown).toContain('Итоговый балл: 0')
    expect(shown).toContain('Продукт: 0 (ответ на 0 из 2, пропуск — низшая оценка)')
    expect(shown.some(line => line.startsWith('Качество результата'))).toBe(false)
  })

  it('без балльных разделов итога нет — и блока итога нет', () => {
    const openOnly: SurveyTemplate = { ...TEMPLATE, sections: [TEMPLATE.sections[1]!] }

    expect(lines(blocks({ T1: 'Пара слов' }, openOnly))).toEqual(['Разбор анкеты — в карточке опроса'])
  })

  it('балльный раздел без балльных вопросов говорит «без оценки»', () => {
    // Публикация такой раздел не пропускает, но перенесённые анкеты опубликованы операторской
    // командой мимо неё. Нашёл тестировщик в панели ревью PR #85.
    const odd: SurveyTemplate = { ...TEMPLATE, sections: [{ ...TEMPLATE.sections[1]!, key: 'odd', title: 'Странный раздел', scored: true }] }

    expect(lines(blocks({ T1: 'Пара слов' }, odd))).toContain(`Странный раздел: ${NO_SCORE_NOTE}`)
  })

  it('текстовых ответов в блоках нет: слова клиента живут в описании, где их обезвреживают', () => {
    // ⚠ Блоки собираются только из чисел и формулировок сотрудника. Текст постороннего человека
    // здесь не обезвреживается — значит и попадать сюда не должен.
    expect(JSON.stringify(blocks({ P1: 9, P2: 8, T1: '[URL=http://чужой]Счёт[/URL]' }))).not.toContain('Счёт')
  })

  it('последний блок ведёт в карточку «Результата опросов» — по пути портала, а не адресом', () => {
    const set = blocks({ P1: 9, P2: 8 })
    const keys = Object.keys(set)

    expect(keys.at(-1)).toBe('card')
    expect(set.card).toEqual({
      type: 'link',
      properties: { text: 'Разбор анкеты — в карточке опроса', action: { type: 'redirect', uri: '/crm/type/1046/details/777/' } },
    })
  })

  it('ключи — только латиница, цифры, дефис и подчёркивание (`KEY_CONTAIN_WRONG_SYMBOLS`)', () => {
    for (const key of Object.keys(blocks({ P1: 9, P2: 8, T1: 'x' }))) expect(key).toMatch(/^[\w-]+$/)
  })
})

describe('предел портала — 20 блоков', () => {
  /** Анкета из `sections` балльных разделов по `questions` вопросов в каждом. */
  function large(sections: number, questions: number): SurveyTemplate {
    return {
      code: 'large',
      title: 'Большая анкета',
      sections: Array.from({ length: sections }, (_, s) => ({
        key: `s${s}`,
        title: `Раздел ${s + 1}`,
        scored: true,
        bands: [],
        questions: Array.from({ length: questions }, (_, q) => ({
          key: `q${s}_${q}`,
          sourceKey: `q${s}_${q}`,
          title: `Вопрос ${q + 1}`,
          type: 'scale' as const,
          weight: 1,
          scored: true,
          scale: { min: 0, max: 10 },
        })),
      })),
    }
  }

  function answered(template: SurveyTemplate): Record<string, number> {
    return Object.fromEntries(template.sections.flatMap(section => section.questions.map(question => [question.key, 7])))
  }

  it('ровно двадцать — всё помещается, баллы вопросов на месте', () => {
    // 1 итог + 3 × (раздел + 5 вопросов) + ссылка = 20.
    const exact = large(3, 5)

    const set = blocks(answered(exact), exact)

    expect(Object.keys(set)).toHaveLength(MAX_LAYOUT_BLOCKS)
    expect(lines(set)).toContain('Вопрос 5: 7 из 10')
  })

  it('ГЛАВНОЕ: не влезает — уходят баллы вопросов, разделы остаются, и ссылка говорит, где вопросы', () => {
    // ⚠ Набор больше двадцати портал отвергает целиком (`TOO_MANY_ITEMS`), и дело осталось бы
    // без блоков вовсе. Лучше таблица разделов, чем ничего.
    const wide = large(4, 5)

    const set = blocks(answered(wide), wide)

    expect(Object.keys(set).length).toBeLessThanOrEqual(MAX_LAYOUT_BLOCKS)
    expect(lines(set)).toEqual([
      'Итоговый балл: 7',
      'Раздел 1: 7',
      'Раздел 2: 7',
      'Раздел 3: 7',
      'Раздел 4: 7',
      'Баллы вопросов — в карточке опроса',
    ])
  })

  it('не влезают и разделы — первые остаются, ссылка говорит про остальное', () => {
    const many = large(25, 1)

    const shown = lines(blocks(answered(many), many))

    expect(shown).toHaveLength(MAX_LAYOUT_BLOCKS)
    expect(shown[0]).toBe('Итоговый балл: 7')
    expect(shown[18]).toBe('Раздел 18: 7')
    expect(shown.at(-1)).toBe('Остальные разделы и баллы вопросов — в карточке опроса')
  })
})

describe('вызов портала', () => {
  it('адресуется парой «сущность + дело» и несёт набор целиком', () => {
    const set = blocks({ P1: 9, P2: 8 })

    expect(buildActivityBlocksCall('9001', { entityTypeId: 1046, entityId: 777 }, set)).toEqual({
      method: ACTIVITY_BLOCKS_SET_METHOD,
      params: { entityTypeId: 1046, entityId: 777, activityId: 9001, layout: { blocks: set } },
    })
  })

  it('принятым считает только `{success: true}` — документированный ответ', () => {
    expect(readBlocksApplied({ result: { success: true } })).toBe(true)
    expect(readBlocksApplied({ result: { success: false } })).toBe(false)
    expect(readBlocksApplied({ result: true })).toBe(false)
    expect(readBlocksApplied(null)).toBe(false)
  })
})
