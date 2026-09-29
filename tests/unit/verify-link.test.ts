import { afterEach, describe, expect, it, vi } from 'vitest'
import { hookBatch, hookCall, report, Stop } from '../../scripts/-hook'
import { PortalError } from '../../server/domain/portals/portal-error'
import { buildAnswers, VERIFY_DATE } from '../../scripts/verify-link'
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

  it('вопрос «Дата» получает постоянный день в записи провода — его и ищут в записанном', () => {
    // Живой путь даты до портала прежде не проверялся вовсе: проверка отвечала на дату `null`
    // (`/code-review`, PR #91). День постоянный, чтобы сверять его в поле ответов и в деле.
    const dated: PublishedTemplate = {
      ...TEMPLATE,
      schema: {
        ...TEMPLATE.schema,
        sections: [{
          ...TEMPLATE.schema.sections[1]!,
          questions: [{ key: 'd1', sourceKey: 'd1', title: 'когда', type: 'date', weight: 0, scored: false }],
        }],
      },
    }

    expect(buildAnswers(dated, 'метка')).toEqual({ d1: VERIFY_DATE })
    expect(VERIFY_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/)
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

describe('диагноз, который видит оператор', () => {
  afterEach(() => vi.restoreAllMocks())

  /** Подделка терминала: собирает всё, что скрипт напечатал при отказе. */
  function printed(error: unknown): string {
    const lines: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...parts) => void lines.push(parts.join(' ')))
    report(error)
    return lines.join('\n')
  }

  it('беда на нашей стороне НЕ выдаётся за отказ портала', () => {
    // ⚠ ГЛАВНЫЙ ГВАРД БЛОКА, и он оплачен потерянным вечером. Живьём: не поднята локальная
    // база, `ECONNREFUSED` на 5432, — а проверка написала «портал отказал, код не распознан»
    // и отправила чинить портал, где всё было в порядке. Диагноз, уводящий не в ту сторону,
    // хуже отсутствующего.
    const failure = new Error('Failed query: select "id" from "portals"')
    failure.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })

    const out = printed(failure)

    expect(out).toContain('НЕ отказ портала')
    expect(out).not.toContain('портал отказал')
  })

  it('машинный код достаётся из ЦЕПОЧКИ причин, а не только сверху', () => {
    // ⚠ Без обхода `cause` видно было бы одно `Error` — то есть ничего. Настоящая обёртка
    // (`DrizzleQueryError`) своего `code` не имеет вовсе, а `ECONNREFUSED` лежит под ней.
    const failure = new Error('обёртка')
    failure.cause = Object.assign(new Error('ниже'), { code: 'ECONNREFUSED' })

    expect(printed(failure)).toContain('ECONNREFUSED')
  })

  it('циклическая цепочка причин не вешает скрипт', () => {
    const first = new Error('первая')
    const second = new Error('вторая')
    first.cause = second
    second.cause = first

    expect(printed(first)).toContain('НЕ отказ портала')
  })

  it('текст нашей ошибки наружу НЕ уходит', () => {
    // ⚠ До этой ветки доходит в том числе ошибка доставки ответа, а её текст способен нести
    // присланное респондентом значение. Инвариант «не логировать текст ответа клиента»
    // действует и в операторском скрипте: печатаем имя класса и код, не сообщение.
    const failure = new Error('ответ клиента: всё плохо, верните деньги')

    expect(printed(failure)).not.toContain('всё плохо')
  })

  it('отказ портала называется кодом, а проза портала остаётся при портале', () => {
    const out = printed(new PortalError('ACCESS_DENIED', 'Access denied: нет прав у пользователя Иванова'))

    expect(out).toContain('ACCESS_DENIED')
    expect(out).not.toContain('Иванова')
  })

  it('незнакомый код портала всё равно виден оператору', () => {
    // `safeRefusal` схлопывает незнакомое в одну фразу — и правильно делает. Но выбор между
    // «чинить права», «чинить вызов» и «подождать» по этой фразе сделать нельзя, а по коду можно.
    const out = printed(new PortalError('SOME_NEW_CODE', 'проза портала'))

    expect(out).toContain('SOME_NEW_CODE')
    expect(out).not.toContain('проза портала')
  })

  it('наш собственный диагноз печатается как есть', () => {
    // `Stop` — текст, написанный для оператора. Пропустить его через фильтр кодов значило бы
    // схлопнуть подробную инструкцию в «код не распознан».
    const out = printed(new Stop('  ✗ Смарт-процесс «Опрос» не найден. Запустите verify:install.', 2))

    expect(out).toContain('verify:install')
  })
})

describe('как вебхук читает ответ с отказом', () => {
  afterEach(() => vi.restoreAllMocks())

  function answer(status: number, body: string) {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status }))
  }

  it('ГЛАВНОЕ: HTTP 400 с телом портала — отказ с кодом, а не беда связи', async () => {
    // ⚠ Замерено 29.09: `crm.activity.layout.blocks.set` вебхуком и `crm.activity.todo.update`
    // по закрытому делу отвечают HTTP 400 с обычным `{error, error_description}`. Раньше такой
    // ответ становился «портал ответил 400, проверьте вебхук» — и код терялся.
    answer(400, JSON.stringify({ error: 'ERROR_WRONG_CONTEXT', error_description: 'Вызов метода возможен только в контексте rest приложения' }))

    const failure = await hookCall('https://portal.example/rest/1/key/')('crm.activity.layout.blocks.set').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(PortalError)
    expect((failure as PortalError).code).toBe('ERROR_WRONG_CONTEXT')
  })

  it.each([['пустой', ''], ['«0»', '0']])('HTTP 400 с кодом %s — отказ портала SHEF_REJECTED, а не беда связи', async (_name, code) => {
    // У `crm.activity.update` документирован и такой отказ: `"error": ""` (`/review`, PR #102), а `"0"`
    // портал прислал 29.09 на правку закрытого дела. Код — тот же, что ставит разборщик SDK (issue #99).
    answer(400, JSON.stringify({ error: code, error_description: 'Access denied.' }))

    const failure = await hookCall('https://portal.example/rest/1/key/')('crm.activity.update').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(PortalError)
    expect((failure as PortalError).code).toBe('SHEF_REJECTED')
  })

  it('двухсотый ответ с кодом «0» — тоже SHEF_REJECTED, как у разборщика SDK', async () => {
    answer(200, JSON.stringify({ error: '0', error_description: 'Some error' }))

    const failure = await hookCall('https://portal.example/rest/1/key/')('crm.activity.update').catch((error: unknown) => error)

    expect((failure as PortalError).code).toBe('SHEF_REJECTED')
  })

  it.each<[string, unknown]>([
    ['пустой `error`', { error: '', error_description: 'Some error' }],
    ['одно поле `time`', { time: { start: 1, finish: 2 } }],
    ['не объект', null],
  ])('ГЛАВНОЕ: двухсотый ответ без `result` (%s) — не успех, а SHEF_UNREACHABLE', async (_name, body) => {
    // ⚠ Прежде такой ответ уезжал к переносу успехом, и пустое чтение значило бы «шаблонов нет» — перенос
    // записал бы второй. Тот же предохранитель, что у `makePortalCall` (`/review` в панели PR #106).
    answer(200, JSON.stringify(body))

    const failure = await hookCall('https://portal.example/rest/1/key/')('crm.item.list').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(PortalError)
    expect((failure as PortalError).code).toBe('SHEF_UNREACHABLE')
  })

  it('не-2xx без тела портала — по-прежнему подсказка оператору', async () => {
    answer(502, '<html>Bad Gateway</html>')

    const failure = await hookCall('https://portal.example/rest/1/key/')('crm.item.get').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Stop)
    expect((failure as Stop).message).toContain('502')
  })

  it('401 с телом портала — тоже подсказка: дело в самом вебхуке', async () => {
    answer(401, JSON.stringify({ error: 'NO_AUTH_FOUND', error_description: 'Wrong authorization data' }))

    const failure = await hookCall('https://portal.example/rest/1/key/')('crm.item.get').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Stop)
  })
})
