import { describe, expect, it } from 'vitest'
import { buildAnswerComment } from '../../server/domain/answers/comment'
import type { SurveyTemplate } from '../../server/domain/surveys/model'
import { scoreSurvey } from '../../server/domain/surveys/scoring'

/**
 * Комментарий в таймлайне — то, ради чего весь путь и затевался: менеджер открывает сделку
 * и видит, что ответил клиент. Здесь держится главное требование раздела 6 `docs/PROCESS.md`
 * — текст **не обрезается** — и то, что в комментарий не уезжает разметка, собранная
 * из набранного посторонним человеком.
 */

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
        { key: 'T2', sourceKey: 'T2', title: 'Что улучшить', type: 'text', weight: 0, scored: false },
      ],
    },
  ],
}

function comment(answers: Record<string, number | string | null>) {
  return buildAnswerComment(TEMPLATE, answers, scoreSurvey(TEMPLATE, answers))
}

describe('комментарий в таймлайн', () => {
  it('не обрезает текст ответа', () => {
    // Требование раздела 6, и оно не про аккуратность: развёрнутый ответ и есть самое
    // ценное, что приносит опрос. Обрезав его до превью, мы оставим менеджеру ровно ту
    // бесполезную среднюю цифру, против которой написан весь проект.
    const long = 'Очень довольны. '.repeat(200)
    const body = comment({ P1: 9, P2: 8, T1: long, T2: null })

    expect(body).toContain(long)
  })

  it('показывает балл секции и текст диапазона', () => {
    const body = comment({ P1: 9, P2: 8, T1: null, T2: null })

    // 9×0.6 + 8×0.4 = 8.6
    expect(body).toContain('Продукт: 8,6')
    expect(body).toContain('Мы на вершине!')
  })

  it('пишет балл русской записью, через запятую', () => {
    expect(comment({ P1: 7, P2: 7, T1: null, T2: null })).toContain('7')
    expect(comment({ P1: 9, P2: 8, T1: null, T2: null })).not.toContain('8.6')
  })

  it('называет неполноту словами', () => {
    // Балл по одному вопросу из двух выглядит так же убедительно, как по двум.
    const body = comment({ P1: 9, P2: null, T1: null, T2: null })

    expect(body).toContain('по 1 из 2')
  })

  it('не перечисляет незаполненные текстовые вопросы', () => {
    // Строка «— не ответил» на каждый пропуск превращает комментарий в перечень пустоты.
    const body = comment({ P1: 9, P2: 8, T1: 'Всё отлично', T2: null })

    expect(body).toContain('Что понравилось')
    expect(body).not.toContain('Что улучшить')
  })

  it('не собирает разметку из ответа клиента', () => {
    // Таймлайн понимает BB-код. Собрав из ответа жирный заголовок, мы отдали бы
    // постороннему человеку управление вёрсткой комментария в чужой CRM.
    const body = comment({ P1: 9, P2: 8, T1: '[B]ВНИМАНИЕ[/B]', T2: null })

    // Сам текст доезжает как есть — обрезать его мы не имеем права…
    expect(body).toContain('[B]ВНИМАНИЕ[/B]')
    // …но своей разметки мы не добавляем ни строчки, и разбирать её структуру нечем.
    expect(body).not.toMatch(/\[B\]Продукт/)
  })

  it('говорит, когда в оцениваемой секции не ответили вовсе', () => {
    // Молчание по целой секции — это сигнал, а не пустое место: менеджер должен
    // увидеть, что его не оценили, а не решить, что опрос сломался.
    const body = comment({ P1: null, P2: null, T1: 'Пара слов', T2: null })

    expect(body).toContain('без оценки')
  })

  it('пишет комментарий и на пустую анкету: молчание тоже сигнал', () => {
    // Человек открыл анкету и отправил её, не ответив ни на что. Промолчать об этом
    // в сделке хуже, чем сказать: менеджер увидел бы опрос в статусе «пройден» и ни следа
    // в истории, и решил бы, что приложение потеряло ответ.
    const body = comment({ P1: null, P2: null, T1: null, T2: null })

    expect(body).toContain('Опрос пройден')
    expect(body).toContain('без оценки')
  })

  it('отдаёт пустую строку, когда сказать нечего вовсе', () => {
    // Портал отвергает пустой комментарий (`INVALID_ARG_VALUE`). Проверяем сами,
    // а не отправляем вслепую и ловим отказ. Случай вырожденный — анкета из одних
    // незаполненных открытых вопросов, — но именно он и даёт пустой текст.
    const openOnly: SurveyTemplate = { ...TEMPLATE, sections: [TEMPLATE.sections[1]!] }

    expect(buildAnswerComment(openOnly, { T1: null, T2: null }, scoreSurvey(openOnly, {}))).toBe('')
  })

  it('выносит итоговый балл отдельной строкой', () => {
    const body = comment({ P1: 9, P2: 8, T1: null, T2: null })

    expect(body).toContain('Итоговый балл: 8,6')
  })
})
