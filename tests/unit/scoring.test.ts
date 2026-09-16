import { describe, expect, it } from 'vitest'
import type { SurveyQuestion, SurveySection, SurveyTemplate } from '../../server/domain/surveys/model'
import { findBand, scoreSurvey } from '../../server/domain/surveys/scoring'

/**
 * Пересчёт баллов — единственное место, где ответ человека превращается в число, по которому
 * потом принимают решения. Здесь держатся два класса отказов, и оба уже случились вживую.
 *
 * Первый: пропуск, посчитанный нулём. В старом решении «поставил ноль» и «не тронул ползунок»
 * это одно значение, и починить те данные уже нельзя — весь инвариант про `null` написан
 * по следам этого. Второй: балл, разошедшийся со старой формулой на сотые, — тогда сверка
 * в задаче 6 не сойдётся и сказать клиенту «один в один» будет нечем.
 */

function scale(key: string, weight: number, extra: Partial<SurveyQuestion> = {}): SurveyQuestion {
  return {
    key,
    sourceKey: key,
    title: `Вопрос ${key}`,
    type: 'scale',
    weight,
    scored: true,
    scale: { min: 0, max: 10 },
    ...extra,
  }
}

function text(key: string): SurveyQuestion {
  return { key, sourceKey: key, title: `Текст ${key}`, type: 'text', weight: 0, scored: false }
}

function section(key: string, questions: SurveyQuestion[], extra: Partial<SurveySection> = {}): SurveySection {
  return { key, title: `Секция ${key}`, scored: true, questions, bands: [], ...extra }
}

function template(sections: SurveySection[]): SurveyTemplate {
  return { code: 'brand', title: 'Оценка работы', sections }
}

describe('балл секции', () => {
  it('считает по формуле источника: значение × вес / 100', () => {
    // Веса во всех двенадцати анкетах дают ровно 100, шкала 0–10. На полностью заполненной
    // анкете наш результат обязан совпасть со старым до сотых — иначе сверять нечего.
    const survey = template([section('product', [scale('a', 50), scale('b', 30), scale('c', 20)])])

    // 9×0.5 + 7×0.3 + 4×0.2 = 4.5 + 2.1 + 0.8 = 7.4
    const result = scoreSurvey(survey, { a: 9, b: 7, c: 4 })

    expect(result.sections[0]!.score).toBe(7.4)
  })

  it('НЕ считает пропуск нулём — это инвариант проекта', () => {
    // Самый дорогой тест файла. Из двух вопросов отвечен один, на девятку. Если `null`
    // войдёт в делитель как ноль, выйдет 4.5 — и «промолчал» станет неотличимо
    // от «поставил ноль» навсегда, ровно как в старом решении.
    const survey = template([section('product', [scale('a', 50), scale('b', 50)])])

    expect(scoreSurvey(survey, { a: 9, b: null }).sections[0]!.score).toBe(9)
  })

  it('НЕ считает пропуск нулём и при неравных весах', () => {
    // Отвечен вопрос с весом 20. Балл — это его значение, а не 8×0.2 = 1.6:
    // делитель пересчитывается по отвеченному.
    const survey = template([section('product', [scale('a', 80), scale('b', 20)])])

    expect(scoreSurvey(survey, { a: null, b: 8 }).sections[0]!.score).toBe(8)
  })

  it('ноль — честный балл, а не отсутствие балла', () => {
    // Обратная сторона предыдущего: человек поставил ноль, и это оценка. Спутать её
    // с `null` значит потерять худшую оценку из всех возможных — именно ту, ради которой
    // опрос и проводят.
    const survey = template([section('product', [scale('a', 100)])])
    const result = scoreSurvey(survey, { a: 0 })

    expect(result.sections[0]!.score).toBe(0)
    expect(result.sections[0]!.score).not.toBeNull()
    expect(result.overall).toBe(0)
  })

  it('без единого ответа балла нет, а не ноль', () => {
    const survey = template([section('product', [scale('a', 50), scale('b', 50)])])
    const result = scoreSurvey(survey, { a: null, b: null })

    expect(result.sections[0]!.score).toBeNull()
    expect(result.sections[0]!.answered).toBe(0)
    expect(result.overall).toBeNull()
  })

  it('не берёт в балл вопросы, выключенные из оценки', () => {
    // В источнике выключение выражалось весом 0 — неотличимо от опечатки. У нас это флаг,
    // и вопрос с ним не должен влиять на балл ни через сумму, ни через делитель.
    const survey = template([section('product', [scale('a', 100), scale('b', 100, { scored: false })])])
    const result = scoreSurvey(survey, { a: 6, b: 10 })

    expect(result.sections[0]!.score).toBe(6)
    expect(result.sections[0]!.scored).toBe(1)
  })

  it('не берёт в балл текстовые вопросы', () => {
    const survey = template([section('product', [scale('a', 100), text('t')])])

    expect(scoreSurvey(survey, { a: 5, t: 'хорошо' }).sections[0]!.score).toBe(5)
  })

  it('у секции без оценки балла нет, сколько бы в ней ни ответили', () => {
    // Секция открытых вопросов. В источнике признаком было пустое `FIELD`.
    const survey = template([section('open', [scale('a', 100)], { scored: false })])

    expect(scoreSurvey(survey, { a: 10 }).sections[0]!.score).toBeNull()
  })

  it('округляет до двух знаков и ровно один раз', () => {
    // 7×(1/3) + 8×(1/3) + 8×(1/3) = 7.666… Округление промежуточных сумм дало бы
    // расхождение с историческим баллом на сотые — то есть провал сверки в задаче 6.
    const survey = template([section('product', [scale('a', 1), scale('b', 1), scale('c', 1)])])

    expect(scoreSurvey(survey, { a: 7, b: 8, c: 8 }).sections[0]!.score).toBe(7.67)
  })

  it('показывает, по скольким вопросам посчитан балл', () => {
    // Без этих двух чисел балл по двум вопросам из пяти выглядит так же убедительно,
    // как посчитанный по пяти, — и менеджер сравнит несравнимое.
    const survey = template([section('product', [scale('a', 40), scale('b', 30), scale('c', 30)])])
    const result = scoreSurvey(survey, { a: 9, b: null, c: 7 })

    expect(result.sections[0]!.answered).toBe(2)
    expect(result.sections[0]!.scored).toBe(3)
  })
})

describe('общий балл', () => {
  it('усредняет СЕКЦИИ, а не все вопросы разом', () => {
    // В «Продукте» три вопроса, в «Персонале» один. Среднее по вопросам дало бы
    // (9+9+9+3)/4 = 7.5 — то есть вес стороны стал бы следствием того, сколько про неё
    // придумали спросить. Среднее по секциям: (9 + 3) / 2 = 6.
    const survey = template([
      section('product', [scale('a', 34), scale('b', 33), scale('c', 33)]),
      section('personal', [scale('p', 100)]),
    ])

    expect(scoreSurvey(survey, { a: 9, b: 9, c: 9, p: 3 }).overall).toBe(6)
  })

  it('не учитывает секции без балла', () => {
    const survey = template([
      section('product', [scale('a', 100)]),
      section('open', [text('t')], { scored: false }),
    ])

    expect(scoreSurvey(survey, { a: 8, t: 'ответ' }).overall).toBe(8)
  })
})

describe('диапазон интерпретации', () => {
  const bands = [
    { from: 4, to: 6, text: 'Где-то мы свернули не туда' },
    { from: 6, to: 7.5, text: 'Есть куда расти' },
    { from: 7.5, to: 10, text: 'Мы на вершине!' },
  ]

  it('берёт диапазон включительно с обеих сторон', () => {
    expect(findBand(bands, 4)?.text).toBe('Где-то мы свернули не туда')
    expect(findBand(bands, 10)?.text).toBe('Мы на вершине!')
  })

  it('на стыке побеждает первый по порядку', () => {
    // Границы в источнике смежные, значит 6 подходит обоим. Выбор объявлен, а не случаен:
    // полуинтервалы оставили бы балл 10 вообще без текста.
    expect(findBand(bands, 6)?.text).toBe('Где-то мы свернули не туда')
  })

  it('вне всех диапазонов — ничего, и это не ошибка', () => {
    // У источника ниже четвёрки не покрыто ничем: клиент с плохой оценкой не видел текста.
    // Адаптер импорта ругается на такие дыры отдельно, здесь просто нет текста.
    expect(findBand(bands, 3.5)).toBeNull()
  })

  it('подставляется к баллу секции целиком', () => {
    const survey = template([section('product', [scale('a', 100)], { bands })])

    expect(scoreSurvey(survey, { a: 9 }).sections[0]!.band?.text).toBe('Мы на вершине!')
  })

  it('у секции без балла диапазона нет', () => {
    const survey = template([section('product', [scale('a', 100)], { bands })])

    expect(scoreSurvey(survey, { a: null }).sections[0]!.band).toBeNull()
  })
})
