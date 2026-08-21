import { describe, expect, it } from 'vitest'
import { buildResultView, RESULT_VIEW_MAX_LINES, RESULT_VIEW_MAX_VALUE } from '../src/domain/result-view'
import { summarizeResponse } from '../src/domain/result-summary'
import type { CompiledVersion, Question, ResponseRecord, StoredAnswer } from '../src/domain/schema'

/**
 * Вид одного ответа для страницы просмотра результата (#18).
 *
 * Отдельно от `summarizeResponse` — потому что пределы у них РАЗНЫЕ и путать их нельзя: карточка в
 * таймлайне режется (15 строк, 300 символов), страница открывается ровно затем, чтобы прочитать ответ
 * целиком.
 */
const q = (over: Partial<Question> & { key: string; text: string }): Question => ({
  type: 'single', metric: 'scale', required: true, options: [], ...over
})

const version = (questions: Question[], over: Partial<CompiledVersion> = {}): CompiledVersion => ({
  surveyKey: 'csat_postdeal',
  title: 'Оценка после сделки',
  lang: 'ru',
  versionNo: 2,
  questions,
  compiledAt: '2026-07-24T10:00:00.000Z',
  ...over
})

const ans = (over: Partial<StoredAnswer> & { questionKey: string }): StoredAnswer => ({
  metric: 'text', valueChoice: [], valueNumber: null, valueText: null, ...over
})

const response = (answers: StoredAnswer[], over: Partial<ResponseRecord> = {}): ResponseRecord => ({
  id: 'r1',
  surveyKey: 'csat_postdeal',
  versionNo: 2,
  submittedAt: '2026-07-24T10:05:00.000Z',
  context: {},
  answers,
  ...over
})

describe('buildResultView — вид одного ответа (#18)', () => {
  it('собирает заголовок ТОЙ версии, момент, строки и число пропущенных', () => {
    const v = version([
      q({ key: 'q_nps', text: 'Насколько вероятно?', metric: 'nps' }),
      q({ key: 'q_why', text: 'Почему?', type: 'text', metric: 'text' }),
      q({ key: 'q_skip', text: 'Пропущенный', type: 'text', metric: 'text' })
    ])
    const view = buildResultView(v, response([
      ans({ questionKey: 'q_nps', metric: 'nps', valueNumber: 9 }),
      ans({ questionKey: 'q_why', valueText: 'быстро сделали' })
    ]))
    expect(view).toBeDefined()
    expect(view!.surveyTitle).toBe('Оценка после сделки')
    expect(view!.versionNo).toBe(2)
    expect(view!.submittedAt).toBe('2026-07-24T10:05:00.000Z')
    expect(view!.lines).toEqual([
      { label: 'Насколько вероятно?', value: '9' },
      { label: 'Почему?', value: 'быстро сделали' }
    ])
    // ⚠️ Число пропущенных считается от вопросов ВЕРСИИ, а не от длины `answers`: пустой ответ в
    // записи есть, но строкой не становится — иначе число разошлось бы с экраном.
    expect(view!.skipped).toBe(1)
  })

  it('версия ДРУГОЙ редакции или другого опроса → вида нет вовсе', () => {
    // ⚠️ Несущее. Опрос могли переиздать между выпиской ссылки и ответом; собери мы экран из новой
    // версии, менеджер увидел бы правдоподобную, но неверную страницу — формулировки одной редакции
    // против ответов другой. Молчание тут честнее подстановки «что нашлось».
    const answers = [ans({ questionKey: 'q_why', valueText: 'x' })]
    expect(buildResultView(version([q({ key: 'q_why', text: 'Почему?' })], { versionNo: 3 }), response(answers)))
      .toBeUndefined()
    expect(buildResultView(version([q({ key: 'q_why', text: 'Почему?' })], { surveyKey: 'nps' }), response(answers)))
      .toBeUndefined()
  })

  it('пределы СТРАНИЦЫ шире, чем у карточки в таймлайне', () => {
    // ⚠️ Ровно то, ради чего отдельная функция. С пределами сводки длинный ответ клиента приезжал бы
    // на страницу обрезанным до 300 символов — то есть человек не получил бы того, за чем открыл.
    const long = 'я'.repeat(1500)
    const v = version([q({ key: 'q_why', text: 'Почему?', type: 'text', metric: 'text' })])
    const r = response([ans({ questionKey: 'q_why', valueText: long })])
    expect(buildResultView(v, r)!.lines[0]!.value).toHaveLength(1500)
    expect(summarizeResponse(v, r)[0]!.value, 'сводка таймлайна тоже перестала резать').toHaveLength(300)
    expect(RESULT_VIEW_MAX_VALUE).toBeGreaterThan(300)
    expect(RESULT_VIEW_MAX_LINES).toBeGreaterThan(15)
  })

  it('срез контекста — ПОИМЁННО, лишнего из снимка не выносит', () => {
    // ⚠️ «Отдадим весь context, вдруг пригодится» — это способ, которым лишние данные уезжают наружу
    // молча: появится в снимке новое поле — и оно окажется на экране без единого решения.
    // `responsibleName` — ПДн сотрудника, и странице оно не нужно (#31).
    const v = version([q({ key: 'q_why', text: 'Почему?' })])
    const view = buildResultView(v, response([ans({ questionKey: 'q_why', valueText: 'x' })], {
      context: {
        dealId: 759, companyId: 101, companyName: 'ООО Ромашка',
        responsibleId: 12, responsibleName: 'Иванов Иван', dealAmount: 100500,
        dealStageId: 'C1:WON', products: [{ productId: 1, productName: 'Внедрение' }]
      }
    }))
    expect(view!.context).toEqual({ dealId: 759, companyId: 101, companyName: 'ООО Ромашка' })
    expect(JSON.stringify(view)).not.toContain('Иванов')
    expect(JSON.stringify(view)).not.toContain('100500')
  })

  it('ответ без единой строки — не ошибка, а честный пустой результат', () => {
    const v = version([q({ key: 'q_why', text: 'Почему?' })])
    const view = buildResultView(v, response([]))
    expect(view!.lines).toEqual([])
    expect(view!.skipped).toBe(1)
  })
})
