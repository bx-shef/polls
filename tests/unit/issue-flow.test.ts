import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PortalError } from '../../server/domain/portals/portal-error'
import type { SurveyTemplate } from '../../server/domain/surveys/model'

/**
 * Выпуск ссылки: что происходит, когда портал или наша база отказывают посреди пути.
 *
 * ⚠ С 28.09 адрес анкеты С ТОКЕНОМ уходит в портал при создании элемента (issue #84, пункт 20).
 * Отсюда две беды, которых раньше не было: текст отказа портала может процитировать адрес,
 * а упавшая запись в наш индекс оставляет в карточке ссылку, ведущую на «не найдено».
 * Обе нашла панель ревью PR #87.
 *
 * Кэш схемы и индекс ссылок подменены: это база, и путь выпуска проверяется без неё —
 * тот же приём, что у журнала в соседних тестах.
 */

const insertLink = vi.fn()
vi.mock('../../server/links/issue', () => ({ cacheTemplate: vi.fn(), insertLink: (...args: unknown[]) => insertLink(...args) }))

const error = vi.fn()
vi.mock('../../server/utils/logger', () => ({ logger: { error: (...args: unknown[]) => error(...args), warn: vi.fn(), info: vi.fn() } }))

const { issueLink } = await import('../../server/links/issue-flow')

const SURVEY = { entityTypeId: 1046, id: 8 }
const SCHEMA = { title: 'Бренд', sections: [] } as unknown as SurveyTemplate

function input(call: (method: string, params?: Record<string, unknown>) => Promise<unknown>) {
  return {
    call: vi.fn(call),
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

beforeEach(() => {
  insertLink.mockReset()
  error.mockReset()
})

describe('отказ портала при создании элемента', () => {
  it('ГЛАВНОЕ: текст отказа с адресом анкеты не выходит наружу', async () => {
    // Битрикс24 цитирует присланное значение в тексте ошибки проверки поля, а в вызове лежит
    // адрес с токеном. Необработанное исключение h3 и Nitro печатают целиком, в обход нашего
    // журнала. Теперь отказ — наш исход, а в журнал уходит только код.
    let quoted = ''
    const issued = await issueLink(input(async (method, params) => {
      if (method !== 'crm.item.add') return { result: true }
      quoted = String((params!.fields as Record<string, unknown>).UF_CRM_8_LINK)
      throw new PortalError('INVALID_ARG_VALUE', `Значение «${quoted}» не подходит полю`)
    }))

    expect(issued).toEqual({ ok: false, reason: 'item-not-created' })
    expect(quoted).toMatch(/^https:\/\/polls\.example\/s\//)
    expect(JSON.stringify(error.mock.calls)).not.toContain(quoted)
    expect(JSON.stringify(error.mock.calls)).toContain('INVALID_ARG_VALUE')
  })
})

describe('отказ нашей базы после создания элемента', () => {
  const created = { result: { item: { id: 501 } } }

  it('ГЛАВНОЕ: элемент отзывается — адрес стёрт, приглашение «отозвано»', async () => {
    // Иначе в карточке осталась бы рабочая на вид ссылка, ведущая на «не найдено»,
    // и менеджер отправил бы её клиенту.
    insertLink.mockRejectedValue(new Error('база недоступна'))
    const request = input(async method => (method === 'crm.item.add' ? created : { result: true }))

    await expect(issueLink(request)).rejects.toThrow('база недоступна')

    const withdraw = request.call.mock.calls.find(([method]) => method === 'crm.item.update')
    expect(withdraw?.[1]).toEqual({
      entityTypeId: SURVEY.entityTypeId,
      id: 501,
      useOriginalUfNames: 'Y',
      fields: { UF_CRM_8_STATE: 'revoked', UF_CRM_8_LINK: '' },
    })
  })

  it('отказ отзыва не прячет исходную беду и называет элемент', async () => {
    insertLink.mockRejectedValue(new Error('база недоступна'))
    const request = input(async (method) => {
      if (method === 'crm.item.add') return created
      if (method === 'crm.item.update') throw new PortalError('QUERY_LIMIT_EXCEEDED', 'Too many requests')
      return { result: true }
    })

    await expect(issueLink(request)).rejects.toThrow('база недоступна')
    expect(error.mock.calls.some(([fields, message]) => (fields as { itemId?: number }).itemId === 501 && String(message).includes('не отозван'))).toBe(true)
  })
})
