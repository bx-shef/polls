import { afterEach, describe, expect, it, vi } from 'vitest'
import { hookBatch } from '../../scripts/-hook'
import { buildAnswers } from '../../scripts/verify-link'
import type { PublishedTemplate } from '../../server/domain/invitations/portal-calls'

/**
 * Гварды на живую проверку `pnpm verify:link`.
 *
 * ⚠ Сама проверка проверяется собой: она либо проходит против тестового портала, либо нет.
 * Но две её детали решают, ЧТО именно она докажет, и ошибка в них делает зелёный прогон
 * ложью — а не падением. Эти две здесь и держатся.
 *
 * ⚠ Импорт `scripts/verify-link` НЕ запускает саму проверку: точка входа в ней закрыта
 * сверкой `import.meta.url` с `process.argv[1]`. Без этого `pnpm check` уходил бы стучаться
 * в портал клиента.
 */

const TEMPLATE: PublishedTemplate = {
  code: 'brand',
  version: 1,
  title: 'Бренд-платформа',
  schema: {
    code: 'brand',
    title: 'Бренд-платформа',
    sections: [
      {
        key: 'product',
        title: 'Продукт',
        scored: true,
        bands: [],
        questions: [
          { key: 'q1', sourceKey: 'q1', title: 'первый', type: 'scale', weight: 50, scored: true, scale: { min: 0, max: 10 } },
          { key: 'q2', sourceKey: 'q2', title: 'второй', type: 'scale', weight: 50, scored: true, scale: { min: 0, max: 5 } },
        ],
      },
      {
        key: 'open',
        title: 'Открытые вопросы',
        scored: false,
        bands: [],
        questions: [
          { key: 't1', sourceKey: 't1', title: 'что понравилось', type: 'text', weight: 0, scored: false },
        ],
      },
    ],
  },
}

describe('ответы, которыми проверка заполняет анкету', () => {
  it('ПЕРВЫЙ балльный вопрос остаётся без ответа', () => {
    // ⚠ ГЛАВНЫЙ ГВАРД ФАЙЛА. «Нет ответа — это `null`, а не ноль» — инвариант проекта,
    // и живая проверка тем и ценна, что проводит его через весь путь до поля на портале.
    // Заполни она все вопросы — прогон остался бы зелёным, а инвариант не проверялся бы
    // вовсе: ровно тот класс отказа, о котором предупреждает `CLAUDE.md`.
    const answers = buildAnswers(TEMPLATE, 'метка')

    expect(answers.q1).toBeNull()
  })

  it('остальные балльные заполняет, не вылезая из шкалы вопроса', () => {
    // У второго вопроса шкала 0–5: восьмёрка не пролезла бы через `checkAnswers`,
    // и проверка падала бы на 422 вместо того, чтобы что-то доказывать.
    const answers = buildAnswers(TEMPLATE, 'метка')

    expect(answers.q2).toBe(5)
  })

  it('в текстовый вопрос кладёт метку прогона — её и ищут в записанном', () => {
    // Сверка «в портале есть то, что мы отправляли» держится на этой строке. Без неё
    // проверка подтверждала бы только «поле непустое» — и прошла бы на дефекте
    // «Результат: 9 без ответов на вопросы», который владелец поймал глазами.
    expect(buildAnswers(TEMPLATE, 'метка').t1).toBe('метка')
  })

  it('на анкете без балльных вопросов не падает', () => {
    const onlyText: PublishedTemplate = {
      ...TEMPLATE,
      schema: { ...TEMPLATE.schema, sections: [TEMPLATE.schema.sections[1]!] },
    }

    expect(buildAnswers(onlyText, 'метка')).toEqual({ t1: 'метка' })
  })
})

describe('пакет через входящий вебхук', () => {
  afterEach(() => vi.restoreAllMocks())

  /** Подделка портала: помнит, что ушло, и отвечает заданным конвертом. */
  function portal(answer: unknown) {
    const seen: unknown[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      seen.push(JSON.parse(String((init as RequestInit).body)))
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    return seen
  }

  it('собирает `cmd` как «метод?параметры» и не прерывается на ошибке', async () => {
    // ⚠ Форма конверта не выдумана: проверена на живом портале 23.09. `halt: 0` — то,
    // на чём держится шапка анкеты: у сделки может не быть компании, и это не повод
    // не показать проект.
    const seen = portal({ result: { result: { deal: { item: { id: 2 } } }, result_error: {} } })

    await hookBatch('https://portal.example/rest/1/key/')({
      deal: { method: 'crm.item.get', params: { entityTypeId: 2, id: 2 } },
    })

    expect(seen[0]).toEqual({
      halt: 0,
      cmd: { deal: 'crm.item.get?entityTypeId=2&id=2' },
    })
  })

  it('отдаёт ТОЛЬКО успешные команды', async () => {
    // ⚠ Так же ведёт себя рабочий `batch` в `server/b24/client.ts`. Разойдись эти две
    // реализации — проверка доказывала бы не то поведение, которое у приложения в бою.
    portal({
      result: {
        result: { deal: { item: { id: 2 } } },
        result_error: { company: { error: 'NOT_FOUND', error_description: 'Элемент не найден' } },
      },
    })

    const data = await hookBatch('https://portal.example/rest/1/key/')({
      deal: { method: 'crm.item.get', params: { id: 2 } },
      company: { method: 'crm.item.get', params: { id: 0 } },
    })

    expect(Object.keys(data)).toEqual(['deal'])
  })

  it('подстановку `$result[…]` не ломает', async () => {
    // Связанные команды — единственная причина, по которой пакет вообще укладывается
    // в одно обращение. Percent-encoding портал понимает: проверено живьём.
    const seen = portal({ result: { result: {}, result_error: {} } })

    await hookBatch('https://portal.example/rest/1/key/')({
      company: { method: 'crm.item.get', params: { id: '$result[deal][item][companyId]' } },
    })

    const cmd = (seen[0] as { cmd: Record<string, string> }).cmd
    expect(decodeURIComponent(cmd.company!)).toBe('crm.item.get?id=$result[deal][item][companyId]')
  })
})
