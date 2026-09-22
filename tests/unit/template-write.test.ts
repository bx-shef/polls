import { describe, expect, it, vi } from 'vitest'
import {
  buildCreateTemplateCall,
  buildListVersionsCall,
  DEFAULT_IMPORT_STATE,
  planTemplateWrites,
  readExistingVersions,
  versionKey,
} from '../../server/domain/import/template-write'
import { writeTemplates } from '../../server/b24/write-templates'
import type { SurveyTemplate } from '../../server/domain/surveys/model'

/**
 * Перенос шаблонов в портал — последнее недостающее звено цепочки.
 *
 * ⚠ Здесь легко нарушить два инварианта разом, и оба тихо: перезаписать опубликованную
 * версию (она неизменяема) и удвоить шаблоны при повторном прогоне. Перенос запускается
 * по живым данным клиента, и «попробуем ещё раз» — его нормальный режим, а не аварийный.
 */

const TEMPLATE = { entityTypeId: 1044, id: 7 }

const schema = (code: string, title = ''): SurveyTemplate => ({ code, title, sections: [] })

function item(code: string, version: number) {
  return { id: 1, UF_CRM_7_CODE: code, UF_CRM_7_VERSION: version }
}

describe('план переноса', () => {
  it('не трогает версию, которая на портале уже есть', () => {
    // ⚠ Опубликованная версия неизменяема — инвариант проекта. Повторный прогон переноса
    // безопасен ПО ПОСТРОЕНИЮ: он ничего не трогает, а не «трогает аккуратно».
    const plan = planTemplateWrites([schema('brand'), schema('design')], new Set([versionKey('brand', 1)]))

    expect(plan.create.map(c => c.code)).toEqual(['design'])
    expect(plan.skip).toEqual([{ code: 'brand', version: 1, reason: 'такая версия на портале уже есть' }])
  })

  it('НЕ кладёт занятый код следующей версией', () => {
    // ⚠ Соблазн есть: «код занят — положим версией 2». Но повторный прогон переноса —
    // это не правка анкеты, а тот же самый перенос; версией 2 мы удвоили бы каждый шаблон
    // при каждом запуске, и через три прогона у клиента было бы тридцать шесть анкет
    // вместо двенадцати.
    const plan = planTemplateWrites([schema('brand')], new Set([versionKey('brand', 1)]))

    expect(plan.create).toHaveLength(0)
  })

  it('повторный код внутри одного снимка записывается один раз', () => {
    // Два шаблона с одним кодом — поломка источника. Записав оба, мы сделали бы выпуск
    // ссылки неоднозначным: какой из них выберет вкладка.
    const plan = planTemplateWrites([schema('brand'), schema('brand')], new Set())

    expect(plan.create).toHaveLength(1)
    expect(plan.skip[0]!.reason).toBe('код повторяется внутри снимка')
  })

  it('без названия в схеме берёт код, а не пустоту', () => {
    // ⚠ Снимок заказчика названий анкет НЕ СОДЕРЖИТ вовсе. Придумать их за клиента мы
    // не можем, а пустое название хуже кода: в списке смарт-процесса будет двенадцать
    // безымянных строк.
    expect(planTemplateWrites([schema('brand')], new Set()).create[0]!.title).toBe('brand')
    expect(planTemplateWrites([schema('brand', 'Бренд')], new Set()).create[0]!.title).toBe('Бренд')
  })
})

describe('состояние записываемой версии', () => {
  it('по умолчанию ЧЕРНОВИК, а не публикация', () => {
    // ⚠ Прямое следствие того, что сказал снимок: названий в источнике нет, значит сразу
    // после переноса анкеты называются кодами. А опубликованная версия неизменяема —
    // опубликовав, мы заморозили бы двенадцать анкет с машинными именами навсегда.
    expect(DEFAULT_IMPORT_STATE).toBe('draft')
  })

  it('у черновика нет даты публикации', () => {
    // Дата публикации черновика — противоречие; пустое поле честно говорит «ещё не публиковали».
    const fields = buildCreateTemplateCall(
      TEMPLATE,
      { code: 'brand', version: 1, title: 'brand', schema: schema('brand') },
      'draft',
      new Date('2026-09-22T10:00:00Z'),
    ).params.fields as Record<string, unknown>

    expect(fields.UF_CRM_7_STATE).toBe('draft')
    expect(fields).not.toHaveProperty('UF_CRM_7_PUBLISHED_AT')
  })

  it('у опубликованной — есть, датой без времени', () => {
    const fields = buildCreateTemplateCall(
      TEMPLATE,
      { code: 'brand', version: 1, title: 'brand', schema: schema('brand') },
      'published',
      new Date('2026-09-22T10:00:00Z'),
    ).params.fields as Record<string, unknown>

    expect(fields.UF_CRM_7_PUBLISHED_AT).toBe('2026-09-22')
  })

  it('схема уезжает строкой — её так же и читают обратно', () => {
    const fields = buildCreateTemplateCall(
      TEMPLATE,
      { code: 'brand', version: 1, title: 'brand', schema: schema('brand', 'Бренд') },
      'draft',
      new Date(),
    ).params.fields as Record<string, unknown>

    expect(typeof fields.UF_CRM_7_SCHEMA).toBe('string')
    expect(JSON.parse(fields.UF_CRM_7_SCHEMA as string).title).toBe('Бренд')
  })
})

describe('чтение того, что уже записано', () => {
  it('собирает пары «код + версия»', () => {
    const keys = readExistingVersions({ result: { items: [item('brand', 1), item('design', 2)] } }, TEMPLATE)

    expect([...keys].sort()).toEqual(['brand@1', 'design@2'])
  })

  it('пропускает строки, которые не с чем сравнить', () => {
    // Приняв мусор за версию, мы пропустили бы настоящую запись — молча.
    const keys = readExistingVersions(
      { result: { items: [item('', 1), item('brand', 0), { id: 3 }, item('ok', 1)] } },
      TEMPLATE,
    )

    expect([...keys]).toEqual(['ok@1'])
  })

  it('схему НЕ запрашивает: она весит больше всего остального вместе взятого', () => {
    const select = buildListVersionsCall(TEMPLATE).params.select as string[]

    expect(select).toContain('UF_CRM_7_CODE')
    expect(select).not.toContain('UF_CRM_7_SCHEMA')
  })

  it('и `id` не запрашивает: с оригинальными именами портал его всё равно не отдаёт', () => {
    // ⚠ Просить системное поле в этом режиме значит делать вид, что оно придёт. Здесь оно
    // и не нужно — сверяются пары «код + версия», — а там, где нужно, берётся `select: ['*']`.
    expect(buildListVersionsCall(TEMPLATE).params.select).not.toContain('id')
  })
})

/** Подделка портала: отвечает по методу, считает вызовы. */
function portal(answers: Record<string, unknown | ((p: Record<string, unknown>) => unknown)> = {}) {
  const calls: { method: string, params: Record<string, unknown> }[] = []
  const call = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params })
    const answer = answers[method]
    if (typeof answer === 'function') return (answer as (p: Record<string, unknown>) => unknown)(params)
    if (answer !== undefined) return answer
    if (method === 'crm.item.list') return { result: { items: [] } }
    if (method === 'crm.item.add') return { result: { item: { id: 42 } } }
    return { result: true }
  })
  return { call, calls, of: (m: string) => calls.filter(c => c.method === m) }
}

describe('перенос против портала', () => {
  const TEMPLATES = [schema('brand'), schema('design')]

  it('сухой прогон НИЧЕГО не создаёт, но показывает что создаст', () => {
    // ⚠ Сухой прогон здесь не режим, а следствие устройства: план строится чистой функцией,
    // и «посмотреть» с «записать» — один и тот же код, а не две ветки, которые разъедутся.
    const p = portal()

    return writeTemplates(p.call, TEMPLATE, TEMPLATES).then((result) => {
      expect(result.dryRun).toBe(true)
      expect(result.written).toBe(0)
      expect(result.create.map(c => c.code)).toEqual(['brand', 'design'])
      expect(p.of('crm.item.add')).toHaveLength(0)
    })
  })

  it('с `apply` создаёт и считает', async () => {
    const p = portal()

    const result = await writeTemplates(p.call, TEMPLATE, TEMPLATES, { apply: true })

    expect(result.written).toBe(2)
    expect(result.failed).toHaveLength(0)
    expect(p.of('crm.item.add')).toHaveLength(2)
  })

  it('повторный прогон не создаёт ничего', async () => {
    // Тот самый случай, ради которого всё это и строилось: перенос запускают несколько раз.
    const p = portal({ 'crm.item.list': { result: { items: [item('brand', 1), item('design', 1)] } } })

    const result = await writeTemplates(p.call, TEMPLATE, TEMPLATES, { apply: true })

    expect(result.written).toBe(0)
    expect(result.skip).toHaveLength(2)
    expect(p.of('crm.item.add')).toHaveLength(0)
  })

  it('одна упавшая запись не обрывает остальные', async () => {
    // ⚠ Перенос из двенадцати анкет, споткнувшийся на второй, оставил бы клиента
    // с четвертью работы и без понятного способа доделать.
    let seen = 0
    const p = portal({
      'crm.item.add': () => {
        seen += 1
        if (seen === 1) throw new Error('ACCESS_DENIED')
        return { result: { item: { id: 42 } } }
      },
    })

    const result = await writeTemplates(p.call, TEMPLATE, TEMPLATES, { apply: true })

    expect(result.written).toBe(1)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]!.code).toBe('brand')
  })

  it('двухсотый ответ без идентификатора не считается переносом', async () => {
    // Портал принял запрос и ничего не создал. Посчитав это успехом, мы отчитались бы
    // о переносе, которого не было.
    const p = portal({ 'crm.item.add': { result: true } })

    const result = await writeTemplates(p.call, TEMPLATE, TEMPLATES, { apply: true })

    expect(result.written).toBe(0)
    expect(result.failed).toHaveLength(2)
  })

  it('текст схемы клиента наружу в отказ не выносится', async () => {
    // ⚠ Битрикс24 цитирует присланное значение в ошибке валидации, а присланное
    // значение здесь — анкета клиента.
    const p = portal({
      'crm.item.add': () => {
        throw new Error('значение «секретная формулировка вопроса» недопустимо для поля')
      },
    })

    const result = await writeTemplates(p.call, TEMPLATE, TEMPLATES, { apply: true })

    expect(JSON.stringify(result.failed)).not.toContain('секретная формулировка')
  })

  it('перелистывает список версий, а не берёт первую страницу', async () => {
    // Наш шаблон на второй странице иначе не нашёлся бы — и мы записали бы дубликат.
    const pages: Record<number, unknown> = {
      0: { result: { items: [item('другое', 1)] }, next: 50 },
      50: { result: { items: [item('brand', 1)] } },
    }
    const p = portal({ 'crm.item.list': (params: Record<string, unknown>) => pages[Number(params.start ?? 0)] })

    const result = await writeTemplates(p.call, TEMPLATE, TEMPLATES, { apply: true })

    expect(result.skip.map(s => s.code)).toEqual(['brand'])
    expect(p.of('crm.item.list')).toHaveLength(2)
  })
})
