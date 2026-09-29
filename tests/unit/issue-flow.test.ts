import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PortalError } from '../../server/domain/portals/portal-error'
import type { SurveyTemplate } from '../../server/domain/surveys/model'

/**
 * Выпуск ссылки: порядок шагов и что происходит, когда портал или наша база отказывают.
 *
 * ⚠ С 28.09 адрес анкеты С ТОКЕНОМ живёт и в CRM клиента (issue #84, пункт 20). Он обязан
 * появляться там только у ссылки, которую наш индекс уже знает: иначе в карточке остаётся рабочая
 * на вид ссылка на «не найдено». И ни отказ портала, ни отказ базы не должны выносить в журнал
 * ни токен, ни его хеш, ни данные клиента. Всё это нашла панель ревью PR #87 в двух кругах.
 *
 * Кэш схемы и индекс ссылок подменены: это база, и путь выпуска проверяется без неё —
 * тот же приём, что у журнала в соседних тестах.
 */

/** Порядок шагов: вызовы портала и запись в индекс — в одну ленту. */
const steps: string[] = []

const insertLink = vi.fn(async (..._link: unknown[]) => {
  steps.push('insertLink')
})
vi.mock('../../server/links/issue', () => ({ cacheTemplate: vi.fn(), insertLink: (...args: unknown[]) => insertLink(...args) }))

const error = vi.fn()
const warn = vi.fn()
vi.mock('../../server/utils/logger', () => ({
  logger: { error: (...args: unknown[]) => error(...args), warn: (...args: unknown[]) => warn(...args), info: vi.fn() },
}))

const { issueLink } = await import('../../server/links/issue-flow')

const SURVEY = { entityTypeId: 1046, id: 8 }
const SCHEMA = { title: 'Бренд', sections: [] } as unknown as SurveyTemplate
const LINK_FIELD = 'UF_CRM_8_LINK'
const created = { result: { item: { id: 501 } } }

type Answer = (method: string, params: Record<string, unknown>) => unknown

/** Портал, который создаёт элемент и дело и не знает за делом ни одной привязки. */
const healthy: Answer = (method) => {
  if (method === 'crm.item.add') return created
  if (method === 'crm.activity.todo.add') return { result: { id: 9100 } }
  if (method === 'crm.activity.binding.list') return { result: [] }
  return { result: true }
}

function input(answer: Answer = healthy) {
  return {
    call: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      steps.push(method)
      return answer(method, params)
    }),
    batch: vi.fn(async () => ({})),
    portalId: 'portal-1',
    domain: 'shef.bitrix24.ru',
    baseUrl: 'https://polls.example',
    survey: SURVEY,
    dealId: 42,
    template: { code: 'brand', version: 1, title: 'Бренд', schema: SCHEMA },
    assignedById: 7,
    managerName: 'Мария',
  }
}

/** Отправил ли выпуск адрес анкеты в портал хоть одним вызовом. */
function sentLink(request: ReturnType<typeof input>): boolean {
  return request.call.mock.calls.some(([, params]) => JSON.stringify(params).includes('/s/'))
}

beforeEach(() => {
  steps.length = 0
  insertLink.mockClear()
  error.mockReset()
  warn.mockReset()
})

describe('порядок шагов', () => {
  it('ГЛАВНОЕ: адрес уходит в элемент только после записи в наш индекс', async () => {
    // Гвард под находку `/code-review` во втором круге PR #87: адрес в `crm.item.add` при упавшем
    // индексе или таймауте создания оставался в карточке ссылкой на «не найдено».
    const request = input()

    const issued = await issueLink(request)

    // Пятым шагом — дело выпуска (issue #84, п. 14): оно несёт тот же адрес и идёт ещё позже.
    expect(steps.slice(0, 4)).toEqual(['crm.item.add', 'insertLink', 'crm.item.update', 'crm.activity.todo.add'])
    const [, create] = request.call.mock.calls[0]!
    expect(JSON.stringify(create)).not.toContain('/s/')
    const [, update] = request.call.mock.calls[1]!
    expect(update).toMatchObject({ id: 501, fields: { [LINK_FIELD]: issued.ok ? issued.url : '' } })
  })

  it('отказ записи адреса выпуск не отменяет: ссылка уже работает', async () => {
    const request = input((method) => {
      if (method === 'crm.item.add') return created
      throw new PortalError('QUERY_LIMIT_EXCEEDED', 'Too many requests')
    })

    const issued = await issueLink(request)

    expect(issued.ok).toBe(true)
    expect(JSON.stringify(warn.mock.calls)).toContain('QUERY_LIMIT_EXCEEDED')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/s/')
  })
})

describe('дело выпуска в ленте сделки (issue #84, п. 14)', () => {
  it('ГЛАВНОЕ: «Отправить опрос клиенту» с выпущенным адресом — после записи индекса и элемента', async () => {
    const request = input()

    const issued = await issueLink(request)

    const add = request.call.mock.calls.find(([method]) => method === 'crm.activity.todo.add')![1]!
    expect(add).toMatchObject({ ownerTypeId: 2, ownerId: 42, title: 'Отправить опрос клиенту: Бренд', responsibleId: 7 })
    expect(String(add.description)).toContain(issued.ok ? issued.url : '—')
    expect(steps.indexOf('crm.activity.todo.add')).toBeGreaterThan(steps.indexOf('insertLink'))
  })

  it('дело получает ключ ВЫПУСКА', async () => {
    const request = input()

    await issueLink(request)

    const mark = request.call.mock.calls.find(([method]) => method === 'crm.activity.update')![1]!
    expect(mark).toMatchObject({ id: 9100, fields: { ORIGINATOR_ID: 'SHEF_SURVEY', ORIGIN_ID: 'survey-link-501' } })
  })

  it('ГЛАВНОЕ: к элементу «Результата опросов» дело выпуска НЕ привязывается', async () => {
    // ⚠ Замер 29.09: финальная стадия элемента закрывает все открытые дела, привязанные к нему.
    // Доставка ставит «Пройдена», отзыв — «Отозвана» раньше, чем трогают дело, и привязанное дело
    // выпуска портал закрывал бы до перезаписи итогом. Первый живой прогон `verify:link` так и упал:
    // итог ушёл новым делом рядом. Привязка — при записи итога, когда стадия уже финальная.
    const request = input()

    await issueLink(request)

    expect(steps).not.toContain('crm.activity.binding.add')
  })

  it('ГЛАВНОЕ: отказ дела выпуск не отменяет, а адрес в журнал не уходит', async () => {
    // ⚠ Ссылка уже работает и видна во вкладке. В вызове дела лежит адрес с токеном, и Битрикс24
    // любит цитировать присланное в тексте ошибки — в журнал уходит только наш код.
    const request = input((method, params) => {
      if (method === 'crm.activity.todo.add') throw new PortalError('ACCESS_DENIED', `нельзя: ${String(params.description)}`)
      return healthy(method, params)
    })

    const issued = await issueLink(request)

    expect(issued.ok).toBe(true)
    expect(JSON.stringify(warn.mock.calls)).toContain('ACCESS_DENIED')
    expect(JSON.stringify([...warn.mock.calls, ...error.mock.calls])).not.toContain('/s/')
  })
})

describe('отказ портала при создании элемента', () => {
  it('ГЛАВНОЕ: текст отказа портала не выходит наружу — только код', async () => {
    // Битрикс24 цитирует присланное значение в тексте ошибки проверки поля, а в вызове лежат
    // название сделки и её клиент. Необработанное исключение h3 и Nitro печатают целиком, в обход
    // нашего журнала. Теперь отказ — наш исход, а в журнал уходит только код. Нашла безопасность.
    const prose = 'Значение «ООО Ромашка» не подходит полю'
    const request = input((method) => {
      if (method === 'crm.item.add') throw new PortalError('INVALID_ARG_VALUE', prose)
      return { result: true }
    })

    const issued = await issueLink(request)

    expect(issued).toEqual({ ok: false, reason: 'item-not-created' })
    expect(JSON.stringify(error.mock.calls)).not.toContain('Ромашка')
    expect(JSON.stringify(error.mock.calls)).toContain('INVALID_ARG_VALUE')
    expect(insertLink).not.toHaveBeenCalled()
  })
})

describe('отказ нашей базы после создания элемента', () => {
  it('ГЛАВНОЕ: адрес в портал не уходит, а ошибка — своя, без текста запроса', async () => {
    // Гвард под находку `/code-review` во втором круге PR #87: драйвер базы кладёт в текст
    // «Failed query … params: …» хеш токена и снимок шапки с именами клиента, а обработчик выпуска
    // исключение не ловит — h3 напечатал бы его целиком.
    const leaky = Object.assign(new Error('Failed query: insert into link_index params: hash,ООО Ромашка'), { cause: { code: '08006' } })
    insertLink.mockRejectedValueOnce(leaky)
    const request = input()

    await expect(issueLink(request)).rejects.toThrow('выпуск ссылки: индекс ссылок не записан')

    expect(sentLink(request)).toBe(false)
    expect(JSON.stringify(error.mock.calls)).not.toContain('Ромашка')
    expect(error.mock.calls.some(([fields]) => (fields as { sqlState?: string }).sqlState === '08006')).toBe(true)
  })

  it('брошенная ошибка не несёт исходную с собой', async () => {
    insertLink.mockRejectedValueOnce(new Error('Failed query: … params: секрет'))

    let thrown: Error | undefined
    try {
      await issueLink(input())
    }
    catch (caught) {
      thrown = caught as Error
    }

    expect(thrown).toBeInstanceOf(Error)
    expect(thrown?.message).not.toContain('секрет')
    expect(thrown?.cause).toBeUndefined()
  })
})
