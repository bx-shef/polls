import { describe, expect, it, vi } from 'vitest'
import { publishTemplates } from '../../server/b24/publish-templates'
import type { SmartProcessRef } from '../../server/domain/portals/smart-processes'
import type { SurveyTemplate } from '../../server/domain/surveys/model'

/**
 * Публикация против портала — интеграционный слой.
 *
 * ⚠ Заведён после `/code-review` PR #50: у переноса такой набор был, а у публикации не было
 * ни одного теста выше чистых функций. А это единственная НЕОБРАТИМАЯ операция проекта:
 * регрессия, из-за которой сухой прогон начал бы писать, уехала бы зелёной.
 */

const TEMPLATE: SmartProcessRef = { id: 8, entityTypeId: 1038 }
const SURVEY: SmartProcessRef = { id: 10, entityTypeId: 1040 }

function schema(code: string, title = code): SurveyTemplate {
  return { code, title, sections: [{ key: 's1', title: 'Секция', scored: true, bands: [], questions: [] }] }
}

/** Карточка шаблона, какой её отдаёт портал. */
function card(code: string, over: Record<string, unknown> = {}) {
  return {
    id: code === 'brand' ? 4 : 6,
    title: `Оценка «${code}»`,
    UF_CRM_8_CODE: code,
    UF_CRM_8_VERSION: 1,
    UF_CRM_8_STATE: 'draft',
    UF_CRM_8_PUBLISHED_AT: '',
    UF_CRM_8_SCHEMA: JSON.stringify(schema(code)),
    ...over,
  }
}

/** Приглашение, какое отдаёт портал. */
function invitation(code: string, state: string) {
  return { UF_CRM_10_TEMPLATE_CODE: code, UF_CRM_10_TEMPLATE_VERSION: 1, UF_CRM_10_STATE: state }
}

/**
 * Подделка портала: отвечает по методу И по `entityTypeId`, считает вызовы.
 *
 * Различать по типу обязательно: публикация читает ДВА списка одним методом `crm.item.list` —
 * шаблоны и приглашения, — и ответ не тому списку прошёл бы незамеченным.
 */
function portal(answers: Record<string, unknown | ((p: Record<string, unknown>) => unknown)> = {}) {
  const calls: { method: string, params: Record<string, unknown> }[] = []

  const call = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params })
    const key = method === 'crm.item.list' ? `${method}:${params.entityTypeId}` : method
    const answer = answers[key]
    if (typeof answer === 'function') return (answer as (p: Record<string, unknown>) => unknown)(params)
    if (answer !== undefined) return answer
    if (method === 'crm.item.list') return { result: { items: [] } }
    return { result: { item: { id: 42 } } }
  })

  return { call, calls, of: (method: string) => calls.filter(c => c.method === method) }
}

/** Портал с двумя названными черновиками и без единого приглашения. */
function ready(over: Record<string, unknown> = {}) {
  return portal({
    'crm.item.list:1038': { result: { items: [card('brand'), card('design')] } },
    'crm.item.list:1040': { result: { items: [] } },
    ...over,
  })
}

describe('публикация против портала', () => {
  it('сухой прогон НИЧЕГО не меняет, но показывает что изменит', async () => {
    // ⚠ Самый дорогой возможный дефект этого скрипта: публикация необратима, и сухой прогон —
    // единственное место, где ошибку ещё можно увидеть.
    const p = ready()

    const result = await publishTemplates(p.call, TEMPLATE, SURVEY)

    expect(result.dryRun).toBe(true)
    expect(result.published).toBe(0)
    expect(result.publish.map(x => x.code)).toEqual(['brand', 'design'])
    expect(p.of('crm.item.update')).toHaveLength(0)
  })

  it('с `apply` публикует и считает', async () => {
    const p = ready()

    const result = await publishTemplates(p.call, TEMPLATE, SURVEY, { apply: true })

    expect(result.published).toBe(2)
    expect(result.failed).toHaveLength(0)
    expect(p.of('crm.item.update')).toHaveLength(2)
  })

  it('повторный прогон не трогает ничего', async () => {
    // Названия уже на месте — значит делать нечего. Безопасность повторного запуска
    // по построению, а не по аккуратности.
    const done = (code: string) => card(code, {
      UF_CRM_8_STATE: 'published',
      UF_CRM_8_PUBLISHED_AT: '2026-09-20',
      UF_CRM_8_SCHEMA: JSON.stringify(schema(code, `Оценка «${code}»`)),
    })
    const p = ready({ 'crm.item.list:1038': { result: { items: [done('brand'), done('design')] } } })

    const result = await publishTemplates(p.call, TEMPLATE, SURVEY, { apply: true })

    expect(result.published).toBe(0)
    expect(result.skip.map(s => s.kind)).toEqual(['already-named', 'already-named'])
    expect(p.of('crm.item.update')).toHaveLength(0)
  })

  it('одна упавшая публикация не обрывает остальные', async () => {
    let seen = 0
    const p = ready({
      'crm.item.update': () => {
        seen += 1
        if (seen === 1) throw new Error('ACCESS_DENIED')
        return { result: { item: { id: 42 } } }
      },
    })

    const result = await publishTemplates(p.call, TEMPLATE, SURVEY, { apply: true })

    expect(result.published).toBe(1)
    expect(result.failed.map(f => f.code)).toEqual(['brand'])
  })

  it('двухсотый ответ без элемента не считается публикацией', async () => {
    // Портал принял запрос и ничего не изменил. Посчитав это успехом, мы отчитались бы
    // о публикации, которой не было.
    const p = ready({ 'crm.item.update': { result: true } })

    const result = await publishTemplates(p.call, TEMPLATE, SURVEY, { apply: true })

    expect(result.published).toBe(0)
    expect(result.failed).toHaveLength(2)
  })

  it('свой код отказа доезжает до оператора, а не схлопывается в «не распознан»', async () => {
    // ⚠ Гвард под дефект, прожиивший от PR #47: `SHEF_*` не было в списке `safeRefusal`,
    // и специально написанный диагноз приходил неотличимым от сетевой беды.
    const p = ready({ 'crm.item.update': { result: true } })

    const result = await publishTemplates(p.call, TEMPLATE, SURVEY, { apply: true })

    expect(result.failed[0]!.reason).toBe('SHEF_UPDATED_NOTHING')
  })

  it('текст анкеты клиента наружу в отказ не выносится', async () => {
    // ⚠ Битрикс24 цитирует присланное значение в ошибке валидации, а присланное значение
    // здесь — схема анкеты клиента.
    const p = ready({
      'crm.item.update': () => {
        throw new Error('значение «секретная формулировка вопроса» недопустимо для поля')
      },
    })

    const result = await publishTemplates(p.call, TEMPLATE, SURVEY, { apply: true })

    expect(JSON.stringify(result.failed)).not.toContain('секретная формулировка')
  })

  it('перелистывает оба списка, а не берёт первую страницу', async () => {
    const templates: Record<number, unknown> = {
      0: { result: { items: [card('brand')] }, next: 50 },
      50: { result: { items: [card('design')] } },
    }
    const surveys: Record<number, unknown> = {
      0: { result: { items: [] }, next: 50 },
      50: { result: { items: [invitation('brand', 'completed')] } },
    }
    const p = portal({
      'crm.item.list:1038': (params: Record<string, unknown>) => templates[Number(params.start ?? 0)],
      'crm.item.list:1040': (params: Record<string, unknown>) => surveys[Number(params.start ?? 0)],
    })

    const result = await publishTemplates(p.call, TEMPLATE, SURVEY)

    // Обе страницы шаблонов прочитаны…
    expect(result.publish.map(x => x.code)).toEqual(['brand', 'design'])
    // …и пройденный опрос со ВТОРОЙ страницы приглашений учтён бы, будь `brand` опубликован.
    expect(p.of('crm.item.list')).toHaveLength(4)
  })

  it('пройденный опрос со второй страницы приглашений запрещает переименование', async () => {
    // ⚠ Главный гвард файла. Неполная сводка тут не «менее точная», она опасная: версия,
    // чьи пройденные опросы лежат на непрочитанной странице, выглядит как «никто не проходил»
    // и открывает переименование, которое инвариант запрещает.
    const surveys: Record<number, unknown> = {
      0: { result: { items: [invitation('design', 'sent')] }, next: 50 },
      50: { result: { items: [invitation('brand', 'completed')] } },
    }
    const p = portal({
      'crm.item.list:1038': { result: { items: [card('brand', { UF_CRM_8_STATE: 'published' })] } },
      'crm.item.list:1040': (params: Record<string, unknown>) => surveys[Number(params.start ?? 0)],
    })

    const result = await publishTemplates(p.call, TEMPLATE, SURVEY, { apply: true })

    expect(result.published).toBe(0)
    expect(result.skip[0]!.kind).toBe('has-answers')
    expect(p.of('crm.item.update')).toHaveLength(0)
  })

  it('недочитанный список приглашений роняет публикацию, а не считается пустым', async () => {
    // ⚠ Упёршись в предел страниц, мы получили бы сводку без последних страниц — то есть
    // «никто не проходил» про всё сразу. Молчать об этом нельзя.
    const p = portal({
      'crm.item.list:1038': { result: { items: [card('brand', { UF_CRM_8_STATE: 'published' })] } },
      'crm.item.list:1040': { result: { items: [invitation('brand', 'sent')] }, next: 50 },
    })

    await expect(publishTemplates(p.call, TEMPLATE, SURVEY, { apply: true })).rejects.toThrow(/не дочитан/)
    expect(p.of('crm.item.update')).toHaveLength(0)
  })

  it('недочитанный список шаблонов тоже роняет, а не публикует половину', async () => {
    const p = portal({
      'crm.item.list:1038': { result: { items: [card('brand')] }, next: 50 },
      'crm.item.list:1040': { result: { items: [] } },
    })

    await expect(publishTemplates(p.call, TEMPLATE, SURVEY, { apply: true })).rejects.toThrow(/не дочитан/)
    expect(p.of('crm.item.update')).toHaveLength(0)
  })

  it('названия анкет в журнал не уходят', async () => {
    // ⚠ Название придумал клиент, и журналу оно не нужно ни при каком разборе.
    const { logger } = await import('../../server/utils/logger')
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger)
    const p = ready()

    await publishTemplates(p.call, TEMPLATE, SURVEY, { apply: true })

    expect(JSON.stringify(info.mock.calls)).not.toContain('Оценка')
    info.mockRestore()
  })
})

describe('транспорт операторских скриптов', () => {
  it('отказ портала превращается в PortalError с кодом, а не в прозу', async () => {
    // ⚠ ГВАРД ПОД НЕТОЧНЫЙ КОММЕНТАРИЙ, который нашла проверка безопасности в PR #50.
    // Комментарий обещал, что ошибка пройдёт через `safeRefusal`, а бросался голый `Error`:
    // `refusalCode` читает только `PortalError.code`, значит обещание не выполнялось.
    // Битрикс24 цитирует присланное значение в ошибке валидации, поэтому обещание
    // из комментария должно быть правдой, а не намерением.
    const { hookCall, report } = await import('../../scripts/-hook')
    const { safeRefusal } = await import('../../server/domain/answers/portal-errors')

    vi.stubGlobal('fetch', async () => new Response(
      JSON.stringify({ error: 'ACCESS_DENIED', error_description: 'значение «текст ответа» недопустимо' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))

    const call = hookCall('https://портал/rest/1/ключ/')
    await expect(call('crm.item.list', {})).rejects.toSatisfy(e => safeRefusal(e) === 'ACCESS_DENIED')

    const printed: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation(m => void printed.push(String(m)))
    report(await call('crm.item.list', {}).catch(e => e))
    spy.mockRestore()
    vi.unstubAllGlobals()

    // Проза портала — а вместе с ней процитированное присланное значение — наружу не ушла.
    expect(printed.join('')).not.toContain('текст ответа')
    expect(printed.join('')).toContain('ACCESS_DENIED')
  })

  it('не-2xx печатается НАШИМ текстом, а не схлопывается в «код не распознан»', async () => {
    // Фильтр против чужой прозы не должен съедать единственную полезную подсказку.
    const { hookCall, report } = await import('../../scripts/-hook')

    vi.stubGlobal('fetch', async () => new Response('<html>502</html>', { status: 502 }))

    const printed: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation(m => void printed.push(String(m)))
    const code = report(await hookCall('https://портал/rest/1/ключ/')('crm.item.list', {}).catch(e => e))
    spy.mockRestore()
    vi.unstubAllGlobals()

    expect(code).toBe(1)
    expect(printed.join('')).toContain('502')
    expect(printed.join('')).not.toContain('не распознан')
  })
})
