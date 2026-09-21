import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_COLOR_BAD,
  ACTIVITY_COLOR_GOOD,
  buildActivityTitle,
  buildTodoActivityCall,
  capTitle,
  hasBadSection,
  MAX_TITLE_BYTES,
  readCreatedActivityId,
  readFoundActivityId,
} from '../../server/domain/answers/timeline-activity'
import type { SurveyTemplate } from '../../server/domain/surveys/model'
import { scoreSurvey } from '../../server/domain/surveys/scoring'

/**
 * Чистая часть дела в таймлайне: цвет, заголовок, разбор ответов.
 *
 * Транспорт (поиск по метке, компенсирующее удаление) проверяется в `answer-delivery.test.ts`
 * подделкой портала — там, где он и живёт.
 */

const TEMPLATE: SurveyTemplate = {
  code: 'demo',
  title: 'Оценка работы по проекту',
  sections: [
    {
      key: 'product',
      title: 'Результат',
      scored: true,
      questions: [
        { key: 'q', sourceKey: 'q', title: 'Довольны?', type: 'scale', weight: 1, scored: true, scale: { min: 0, max: 10 } },
      ],
      bands: [
        { from: 0, to: 6.5, text: 'Мы вас подвели.' },
        { from: 6.5, to: 8.5, text: 'Есть что улучшить.' },
        { from: 8.5, to: 10, text: 'Спасибо!' },
      ],
    },
  ],
}

const score = (value: number | null) => scoreSurvey(TEMPLATE, { q: value })

describe('цвет дела', () => {
  it('красный, когда раздел упал в САМЫЙ НИЖНИЙ свой диапазон', () => {
    expect(hasBadSection(TEMPLATE, score(3))).toBe(true)
  })

  it('не красный на середине и наверху', () => {
    expect(hasBadSection(TEMPLATE, score(7))).toBe(false)
    expect(hasBadSection(TEMPLATE, score(10))).toBe(false)
  })

  it('порог берётся из шаблона, а не из нашего кода', () => {
    // ⚠ Прямое следствие правила «средний балл не выносится главной метрикой». Нижний
    // диапазон — это то, что клиент назвал плохим у себя. Придумав свою границу, мы
    // покрасили бы дело вопреки тому, что он написал в анкете.
    const strict: SurveyTemplate = {
      ...TEMPLATE,
      sections: [{ ...TEMPLATE.sections[0]!, bands: [{ from: 0, to: 9, text: 'плохо' }, { from: 9, to: 10, text: 'хорошо' }] }],
    }

    expect(hasBadSection(strict, scoreSurvey(strict, { q: 8 }))).toBe(true)
    expect(hasBadSection(TEMPLATE, score(8))).toBe(false)
  })

  it('раздел без диапазонов ничего не решает', () => {
    // Сказать про него «плохо» не на чем.
    const bandless: SurveyTemplate = { ...TEMPLATE, sections: [{ ...TEMPLATE.sections[0]!, bands: [] }] }

    expect(hasBadSection(bandless, scoreSurvey(bandless, { q: 0 }))).toBe(false)
  })

  it('пропуск не красит дело красным', () => {
    // Нетронутый ползунок — это `null`, а не ноль. Покрасив его в красный, мы объявили бы
    // непройденную секцию плохой оценкой.
    expect(hasBadSection(TEMPLATE, score(null))).toBe(false)
  })

  it('цвет отправляется всегда', () => {
    // ⚠ У жёлтого идентификатора нет — он получается, если `colorId` не передать. Значит
    // забытый параметр читался бы на портале как осознанный выбор.
    const call = buildTodoActivityCall({
      dealEntityTypeId: 2,
      dealId: 1,
      title: 'т',
      description: 'о',
      deadline: new Date('2026-09-21T12:00:00Z'),
      color: ACTIVITY_COLOR_BAD,
    })

    expect(call.params.colorId).toBe(ACTIVITY_COLOR_BAD)
    expect(ACTIVITY_COLOR_BAD).not.toBe(ACTIVITY_COLOR_GOOD)
  })

  it('срок уходит без зоны и без миллисекунд', () => {
    // `WRONG_DATETIME_FORMAT` — один из заявленных отказов метода; документация показывает
    // `2025-02-03T15:00:00`.
    const call = buildTodoActivityCall({
      dealEntityTypeId: 2,
      dealId: 1,
      title: 'т',
      description: 'о',
      deadline: new Date('2026-09-21T12:00:00.123Z'),
      color: ACTIVITY_COLOR_GOOD,
    })

    expect(call.params.deadline).toBe('2026-09-21T12:00:00')
  })
})

describe('заголовок дела', () => {
  it('несёт название анкеты и итог', () => {
    expect(buildActivityTitle(TEMPLATE, score(9))).toBe('Опрос пройден: Оценка работы по проекту — 9')
  })

  it('балл в русской записи', () => {
    const half: SurveyTemplate = {
      ...TEMPLATE,
      sections: [{
        ...TEMPLATE.sections[0]!,
        questions: [
          TEMPLATE.sections[0]!.questions[0]!,
          { key: 'w', sourceKey: 'w', title: 'Срок?', type: 'scale', weight: 1, scored: true, scale: { min: 0, max: 10 } },
        ],
      }],
    }

    expect(buildActivityTitle(half, scoreSurvey(half, { q: 9, w: 8 }))).toContain('8,5')
  })

  it('без итога хвоста нет', () => {
    expect(buildActivityTitle(TEMPLATE, score(null))).toBe('Опрос пройден: Оценка работы по проекту')
  })

  it('режется и по символам, и по БАЙТАМ', () => {
    // ⚠ Два предела, а не один: портал считает символы, а правило проекта требует мерить
    // байты, потому что кириллица весит вдвое. Обрезав только по символам, мы отдали бы
    // в поле на 255 строку в 500 байт.
    const capped = capTitle('я'.repeat(400))

    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(MAX_TITLE_BYTES)
    expect(capped.length).toBeLessThan(400)
  })

  it('короткий заголовок не трогает', () => {
    expect(capTitle('Опрос пройден')).toBe('Опрос пройден')
  })
})

describe('разбор ответов портала', () => {
  it('принимает обе формы идентификатора созданного дела', () => {
    // ⚠ Документация обещает `{result:{id}}`, у соседа часть порталов отвечала `{result: id}`.
    expect(readCreatedActivityId({ result: { id: 999 } })).toBe('999')
    expect(readCreatedActivityId({ result: 999 })).toBe('999')
  })

  it('не принимает за идентификатор то, что им не является', () => {
    // Приняв мусор, мы нанесли бы метку в пустоту и спрятали поломку за успешным вызовом.
    expect(readCreatedActivityId({ result: { id: 'abc' } })).toBeNull()
    expect(readCreatedActivityId({ result: null })).toBeNull()
    expect(readCreatedActivityId(null)).toBeNull()
  })

  it('пустой поиск — это «ещё не писали», а не ошибка', () => {
    expect(readFoundActivityId({ result: [] })).toBeNull()
    expect(readFoundActivityId(null)).toBeNull()
    expect(readFoundActivityId({ result: [{ ID: 42 }] })).toBe('42')
  })
})
