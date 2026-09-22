import { describe, expect, it } from 'vitest'
import {
  buildCreateSurveyItemCall,
  buildListTemplatesCall,
  buildInvitationTitle,
  buildReadDealCall,
  DEAL_ENTITY_TYPE_ID,
  readCreatedItemId,
  readDealFacts,
  readPublishedTemplates,
} from '../../server/domain/invitations/portal-calls'
import type { SurveyTemplate } from '../../server/domain/surveys/model'

/**
 * Вызовы портала для выпуска ссылки. Ошибка здесь не падает: она либо не находит анкету,
 * которая на портале есть, либо создаёт приглашение без связи со сделкой — и второе
 * обнаруживается только тогда, когда менеджер идёт искать его в карточке.
 */

const TEMPLATE = { entityTypeId: 1044, id: 7 }
const SURVEY = { entityTypeId: 1046, id: 8 }

const SCHEMA: SurveyTemplate = { code: 'brand', title: 'Бренд-платформа', sections: [] }

const INVITATION = {
  templateCode: 'brand',
  templateVersion: 1,
  expiresAt: new Date('2026-10-16T12:00:00Z'),
  title: 'Бренд-платформа',
}

function item(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: 'Бренд-платформа',
    UF_CRM_7_CODE: 'brand',
    UF_CRM_7_VERSION: 1,
    UF_CRM_7_STATE: 'published',
    UF_CRM_7_SCHEMA: JSON.stringify(SCHEMA),
    ...over,
  }
}

describe('запрос списка шаблонов', () => {
  it('просит оригинальные имена полей, а не camelCase', () => {
    // По умолчанию `crm.item.*` работает именами вида `ufCrm44_...`. Мы создавали поля
    // как `UF_CRM_<id>_CODE`, и угадывать преобразование уже обжигались на
    // `userfieldconfig.list` — там часть полей не находилась НИКОГДА.
    expect(buildListTemplatesCall(TEMPLATE).params.useOriginalUfNames).toBe('Y')
  })

  it('просит `*`, а не перечень полей: иначе системные не придут', () => {
    // ⚠ ГВАРД ПОД НАЙДЕННЫЙ ЖИВЬЁМ ДЕФЕКТ. Прежняя редакция перечисляла `id`, `title`
    // и четыре наших поля — и не получала `id` с `title` НИКОГДА: с `useOriginalUfNames: 'Y'`
    // портал honours в `select` только оригинальные имена пользовательских полей, а системные
    // молча выбрасывает, в любом написании. Из-за этого запасное название шаблона по имени
    // элемента не срабатывало ни разу.
    expect(buildListTemplatesCall(TEMPLATE).params.select).toEqual(['*'])
  })

  it('адресует элементы по entityTypeId, а не по id типа', () => {
    // Два разных числа, и это ровно та путаница, что стоила полей при установке.
    expect(buildListTemplatesCall(TEMPLATE).params.entityTypeId).toBe(1044)
  })

  it('перелистывает со смещением, а первую страницу просит без него', () => {
    expect(buildListTemplatesCall(TEMPLATE).params).not.toHaveProperty('start')
    expect(buildListTemplatesCall(TEMPLATE, 50).params.start).toBe(50)
  })
})

describe('разбор списка шаблонов', () => {
  it('читает опубликованный шаблон целиком', () => {
    const published = readPublishedTemplates({ result: { items: [item()] } }, TEMPLATE)

    expect(published).toEqual([{ code: 'brand', version: 1, title: 'Бренд-платформа', schema: SCHEMA }])
  })

  it('не показывает неопубликованные', () => {
    // Выпустить ссылку на черновик значит выдать человеку анкету, которой ещё нет.
    const published = readPublishedTemplates({ result: { items: [item({ UF_CRM_7_STATE: 'draft' })] } }, TEMPLATE)

    expect(published).toEqual([])
  })

  it.each<[Record<string, unknown>, string]>([
    [{ UF_CRM_7_SCHEMA: 'не json' }, 'схема не разбирается'],
    [{ UF_CRM_7_SCHEMA: '{"нет":"секций"}' }, 'схема не той формы'],
    [{ UF_CRM_7_CODE: '' }, 'нет кода'],
    [{ UF_CRM_7_VERSION: 0 }, 'версия не положительная'],
    [{ UF_CRM_7_VERSION: 'первая' }, 'версия не число'],
  ])('пропускает негодный шаблон (%#: %s)', (broken) => {
    // Выпустить по нему ссылку значит выдать страницу, которая не откроется.
    expect(readPublishedTemplates({ result: { items: [item(broken)] } }, TEMPLATE)).toEqual([])
  })

  it('берёт название из СХЕМЫ, а не из имени элемента', () => {
    // ⚠ Гвард под замечание владельца: заголовок был неинформативным. Имя элемента пишет
    // сотрудник для себя, и на живом портале это оказался служебный код `demo` — он уезжал
    // и в название приглашения, и в заголовок дела. Название анкеты живёт в схеме: его видит
    // респондент, оно и осмысленно.
    const named = readPublishedTemplates(
      { result: { items: [item({ title: 'demo', UF_CRM_7_SCHEMA: JSON.stringify({ ...SCHEMA, title: 'Оценка работы по проекту' }) })] } },
      TEMPLATE,
    )

    expect(named[0]!.title).toBe('Оценка работы по проекту')
  })

  it('без названия в схеме берёт КОД, а имя элемента не берёт никогда', () => {
    // ⚠ ГВАРД ПОД РЕШЕНИЕ, а не под поведение. Имя элемента запасным вариантом стояло
    // с первого дня и не срабатывало ни разу: `title` в ответе не приходил вовсе из-за
    // `select` (см. `buildListTemplatesCall`). Починив `select` в PR #50, мы эту ветку
    // оживили бы — и вот тогда она стала бы вредной: имя элемента правится на портале кем
    // угодно, а опубликованная версия обязана быть неизменяемой, иначе сотрудник задним
    // числом переименует версию, по которой уже собрана статистика. Назвать анкету можно,
    // но до публикации и через схему — `pnpm publish:templates`.
    const noSchemaTitle = JSON.stringify({ ...SCHEMA, title: '' })

    const withItemName = readPublishedTemplates({ result: { items: [item({ title: 'Вручную', UF_CRM_7_SCHEMA: noSchemaTitle })] } }, TEMPLATE)
    expect(withItemName[0]!.title).toBe('brand')

    const withoutItemName = readPublishedTemplates({ result: { items: [item({ title: '', UF_CRM_7_SCHEMA: noSchemaTitle })] } }, TEMPLATE)
    expect(withoutItemName[0]!.title).toBe('brand')
  })

  it.each<[unknown, string]>([
    [{ result: {} }, 'нет items'],
    [{ result: { items: 'строка' } }, 'items не массив'],
    [null, 'нет ответа'],
  ])('не падает на негодном ответе (%#: %s)', (response) => {
    expect(readPublishedTemplates(response, TEMPLATE)).toEqual([])
  })
})

describe('создание приглашения', () => {
  const call = buildCreateSurveyItemCall(SURVEY, 42, {
    templateCode: 'brand',
    templateVersion: 1,
    expiresAt: new Date('2026-10-16T12:00:00Z'),
    title: 'Бренд-платформа',
  })

  it('связывает приглашение со сделкой полем-родителем', () => {
    // `parentId<entityTypeId>`; у сделки это 2. Без связи приглашение не найдётся
    // в карточке, и менеджер решит, что ничего не выпустилось.
    expect((call.params.fields as Record<string, unknown>)[`parentId${DEAL_ENTITY_TYPE_ID}`]).toBe(42)
    expect(DEAL_ENTITY_TYPE_ID).toBe(2)
  })

  it('заполняет поля оригинальными именами', () => {
    const fields = call.params.fields as Record<string, unknown>

    expect(call.params.useOriginalUfNames).toBe('Y')
    expect(fields.UF_CRM_8_TEMPLATE_CODE).toBe('brand')
    expect(fields.UF_CRM_8_TEMPLATE_VERSION).toBe(1)
    expect(fields.UF_CRM_8_STATE).toBe('sent')
  })

  it('отдаёт срок датой без времени', () => {
    // Поле создавалось типом `date`: отдать ему полный ISO значит понадеяться
    // на снисходительность портала.
    expect((call.params.fields as Record<string, unknown>).UF_CRM_8_EXPIRES_AT).toBe('2026-10-16')
  })
})

describe('идентификатор созданного элемента', () => {
  it('читается из ответа', () => {
    expect(readCreatedItemId({ result: { item: { id: 17 } } })).toBe(17)
  })

  it.each<[unknown, string]>([
    [{ result: { item: {} } }, 'нет id'],
    [{ result: {} }, 'нет item'],
    [{ result: { item: { id: 0 } } }, 'нулевой id'],
    [null, 'нет ответа'],
  ])('не выдумывается из негодного ответа (%#: %s)', (response) => {
    // Записать ссылку без настоящего элемента значит потерять связь приглашения
    // с порталом навсегда.
    expect(readCreatedItemId(response)).toBeNull()
  })
})

describe('клиент сделки в приглашении', () => {
  it('переносится снимком на момент выпуска', () => {
    // ⚠ Снимок, а не вычисление потом: клиента у сделки меняют, и «кого мы спрашивали»
    // разошлось бы с «кто там сейчас».
    const fields = buildCreateSurveyItemCall(SURVEY, 42, {
      ...INVITATION,
      client: { contactId: 7, companyId: 9 },
    }).params.fields as Record<string, unknown>

    expect(fields.contactId).toBe(7)
    expect(fields.companyId).toBe(9)
  })

  it('нули не отправляются вовсе', () => {
    // ⚠ Портал понял бы ноль как «очистить», а не как «значения нет». У сделки физлица
    // компании нет, и отправив `companyId: 0`, мы бы затёрли то, чего не знаем.
    const fields = buildCreateSurveyItemCall(SURVEY, 42, {
      ...INVITATION,
      client: { contactId: 7, companyId: 0 },
    }).params.fields as Record<string, unknown>

    expect(fields).toHaveProperty('contactId')
    expect(fields).not.toHaveProperty('companyId')
  })

  it('без клиента приглашение всё равно создаётся', () => {
    // Чтение клиента — удобство. Отказать в выпуске из-за него значит поменять местами
    // главное и второстепенное.
    const fields = buildCreateSurveyItemCall(SURVEY, 42, INVITATION).params.fields as Record<string, unknown>

    expect(fields).not.toHaveProperty('contactId')
    expect(fields.parentId2).toBe(42)
  })

  it('читает клиента и название, отсеивая нули и мусор', () => {
    expect(readDealFacts({ result: { item: { contactId: 2, companyId: '3', title: ' Test ' } } }))
      .toEqual({ contactId: 2, companyId: 3, title: 'Test' })
    expect(readDealFacts({ result: { item: { contactId: 0, companyId: null } } }))
      .toEqual({ contactId: 0, companyId: 0, title: '' })
    expect(readDealFacts(null)).toEqual({ contactId: 0, companyId: 0, title: '' })
  })

  it('НЕ передаёт `select` — у метода такого параметра нет', () => {
    // ⚠ Гвард под находку панели. Документированы только `entityTypeId`, `id`
    // и `useOriginalUfNames`; портал молча игнорировал `select`, а комментарий и прежний
    // тест обещали экономию, которой не существует. Обещать несуществующую гарантию хуже,
    // чем не обещать ничего: следующий читатель на неё положится.
    const call = buildReadDealCall(42)

    expect(call.params.entityTypeId).toBe(DEAL_ENTITY_TYPE_ID)
    expect(call.params).not.toHaveProperty('select')
  })

  it('ответственный ставится явно — иначе портал повесит дело на владельца токена', () => {
    // Элемент создаётся токеном приложения, то есть по умолчанию ответственным станет
    // администратор, ставивший приложение, а не сотрудник, нажавший «выпустить».
    const fields = buildCreateSurveyItemCall(SURVEY, 42, { ...INVITATION, assignedById: 12 })
      .params.fields as Record<string, unknown>

    expect(fields.assignedById).toBe(12)
    expect(buildCreateSurveyItemCall(SURVEY, 42, INVITATION).params.fields)
      .not.toHaveProperty('assignedById')
  })

  it('название приглашения несёт и анкету, и сделку', () => {
    // Двадцать строк «Оценка работы по проекту» подряд в списке смарт-процесса
    // не отвечают ни на один вопрос.
    expect(buildInvitationTitle('Оценка работы', 'Ремонт кровли')).toBe('Оценка работы — Ремонт кровли')
    expect(buildInvitationTitle('Оценка работы', '')).toBe('Оценка работы')
    expect(buildInvitationTitle('', '')).toBe('Опрос')
  })
})
