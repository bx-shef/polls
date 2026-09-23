import { describe, expect, it } from 'vitest'
import { toPublicHeader, toPublicSurvey } from '../../server/api/s/-view'
import type { SurveyTemplate } from '../../server/domain/surveys/model'

/**
 * Граница между анкетой и посторонним человеком. Всё, что просочится сюда, увидит тот,
 * кому прислали ссылку, — и не только он: ссылку пересылают, страницу сохраняют.
 */

const TEMPLATE: SurveyTemplate = {
  code: 'brand',
  title: 'Бренд-платформа',
  sections: [
    {
      key: 'product',
      title: 'Продукт',
      scored: true,
      bands: [{ from: 0, to: 6, text: 'Где-то мы свернули не туда' }],
      questions: [
        { key: 'Q1', sourceKey: 'ИСХОДНЫЙ', title: 'Первый', type: 'scale', weight: 70, scored: true, scale: { min: 0, max: 10 } },
        { key: 'T1', sourceKey: 'T1', title: 'Что понравилось', type: 'text', weight: 0, scored: false },
      ],
    },
  ],
}

describe('что уходит на публичную страницу', () => {
  it('отдаёт вопросы, заголовки и шкалу', () => {
    expect(toPublicSurvey(TEMPLATE)).toEqual({
      title: 'Бренд-платформа',
      sections: [{
        key: 'product',
        title: 'Продукт',
        questions: [
          { key: 'Q1', title: 'Первый', type: 'scale', scale: { min: 0, max: 10 } },
          { key: 'T1', title: 'Что понравилось', type: 'text' },
        ],
      }],
    })
  })

  it('не отдаёт веса вопросов', () => {
    // Вес — настройка клиента, а не свойство вопроса для отвечающего. Зная веса, можно
    // выбирать, на какие вопросы отвечать «правильно», чтобы вытянуть балл.
    expect(JSON.stringify(toPublicSurvey(TEMPLATE))).not.toContain('70')
    expect(JSON.stringify(toPublicSurvey(TEMPLATE))).not.toContain('weight')
  })

  it('не отдаёт признак «идёт в оценку»', () => {
    expect(JSON.stringify(toPublicSurvey(TEMPLATE))).not.toContain('scored')
  })

  it('не отдаёт диапазоны интерпретации', () => {
    // Это тексты, которые клиент пишет ПРО СЕБЯ и для своих отчётов. Респонденту
    // их показывают отдельно и не всегда — решать это не формату провода.
    expect(JSON.stringify(toPublicSurvey(TEMPLATE))).not.toContain('свернули не туда')
    expect(JSON.stringify(toPublicSurvey(TEMPLATE))).not.toContain('bands')
  })

  it('не отдаёт исходные коды полей старого решения', () => {
    // `sourceKey` — след миграции. Наружу он не нужен никому и ничего не даёт,
    // кроме подсказки о том, откуда взялись данные.
    expect(JSON.stringify(toPublicSurvey(TEMPLATE))).not.toContain('ИСХОДНЫЙ')
    expect(JSON.stringify(toPublicSurvey(TEMPLATE))).not.toContain('sourceKey')
  })

  it('не приписывает шкалу текстовому вопросу', () => {
    const question = toPublicSurvey(TEMPLATE).sections[0]!.questions[1]!

    expect(question).not.toHaveProperty('scale')
  })
})

describe('шапка анкеты наружу', () => {
  const HEADER = {
    company: 'Ромашка Дистрибуция',
    project: 'Рекламная кампания, осень',
    respondent: 'Игорь Петров',
    manager: 'Мария Ковалёва',
  }

  it('отдаёт снимок вместе с датой выпуска', () => {
    // Дата берётся у самой ссылки (`created_at`), а не хранится в снимке вторым ответом
    // на тот же вопрос.
    expect(toPublicHeader(HEADER, new Date('2026-09-12T14:20:00Z')))
      .toEqual({ ...HEADER, issuedAt: '2026-09-12T14:20:00.000Z' })
  })

  it('ссылка без шапки — это `null`, а не пустой объект', () => {
    // ⚠ Такие ссылки уже есть в базе: их выпустили до появления снимка. Пустой объект
    // страница отрисовала бы шапкой из пустых строк — дырой во весь экран вместо анкеты.
    expect(toPublicHeader(null, new Date())).toBeNull()
  })

  it('отдаёт ровно пять полей и ни одного лишнего', () => {
    // ⚠ Шапка — единственное место, где наружу уезжают имена людей. Поле, добавленное
    // в снимок «для отчёта», уехало бы вместе с ними постороннему респонденту.
    expect(Object.keys(toPublicHeader(HEADER, new Date())!).sort())
      .toEqual(['company', 'issuedAt', 'manager', 'project', 'respondent'])
  })
})
