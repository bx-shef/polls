import { describe, expect, it } from 'vitest'
import {
  buildListIssuedCall,
  buildRevokeCall,
  type IssuedLink,
  isRevocable,
  issuedState,
  readIssuedLinks,
  SURVEY_STATE_REVOKED,
} from '../../server/domain/invitations/issued-links'
import { buildFieldName } from '../../server/domain/portals/smart-processes'

/**
 * Список выпущенных ссылок во вкладке сделки (issue #20).
 *
 * Здесь держится то, ошибка в чём выглядит как работающая вкладка: список показывается,
 * состояния расставлены, кнопки нажимаются — и всё это про чужие данные или не про то.
 */

const SURVEY = { entityTypeId: 1040, id: 10 }
const DEAL = 2

/** Как отвечает портал: имена полей строятся по `id` смарт-процесса, не по `entityTypeId`. */
function portalItem(over: Record<string, unknown> = {}) {
  return {
    id: 54,
    title: 'Бренд-платформа — ООО «Ромашка»',
    assignedById: 7,
    createdTime: '2026-09-24T12:00:00+03:00',
    [buildFieldName(SURVEY.id, 'TEMPLATE_CODE')]: 'brand',
    [buildFieldName(SURVEY.id, 'TEMPLATE_VERSION')]: '1',
    [buildFieldName(SURVEY.id, 'STATE')]: 'sent',
    [buildFieldName(SURVEY.id, 'EXPIRES_AT')]: '2026-10-24T00:00:00+03:00',
    [buildFieldName(SURVEY.id, 'COMPLETED_AT')]: '',
    [buildFieldName(SURVEY.id, 'SCORE')]: '',
    ...over,
  }
}

const link = (over: Partial<IssuedLink> = {}): IssuedLink => ({
  itemId: 54,
  title: 'Бренд-платформа',
  code: 'brand',
  version: 1,
  state: 'sent',
  expiresAt: '2026-10-24T00:00:00+03:00',
  completedAt: '',
  score: null,
  assignedById: 7,
  createdAt: '2026-09-24T12:00:00+03:00',
  ...over,
})

describe('запрос списка', () => {
  it('ГЛАВНОЕ: сужен по родительской сделке', () => {
    // ⚠ Без фильтра `crm.item.list` отдаёт элементы всего портала — то есть вкладка показала бы
    // менеджеру опросы по чужим сделкам, включая те, к которым у него нет доступа. Форма
    // фильтра проверена на живом портале 24.09: 26 элементов всего, 24 у сделки 2,
    // 0 у несуществующей.
    const params = buildListIssuedCall(SURVEY, DEAL).params

    expect(params.filter).toEqual({ parentId2: DEAL })
  })

  it('просит `*` и оригинальные имена полей', () => {
    // ⚠ Разбор уже записан в `docs/PROCESS.md`: `crm.item.list` с `useOriginalUfNames`
    // молча теряет системные поля, если не попросить `*`. А системные здесь — это `id`
    // и `assignedById`, то есть половина списка.
    const params = buildListIssuedCall(SURVEY, DEAL).params

    expect(params.select).toEqual(['*'])
    expect(params.useOriginalUfNames).toBe('Y')
  })

  it('новые сверху', () => {
    expect(buildListIssuedCall(SURVEY, DEAL).params.order).toEqual({ id: 'desc' })
  })
})

describe('разбор ответа портала', () => {
  it('ГЛАВНОЕ: поля читаются по `id` смарт-процесса, а не по `entityTypeId`', () => {
    // ⚠ Проверено на живом портале: поля называются `UF_CRM_10_STATE` при `entityTypeId`
    // 1040. Перепутав, мы прочитали бы `undefined` во всех полях — и показали бы список
    // из пустых строк. Молча и правдоподобно: элементы-то есть.
    const [read] = readIssuedLinks({ result: { items: [portalItem()] } }, SURVEY)

    expect(read).toMatchObject({ itemId: 54, code: 'brand', version: 1, state: 'sent' })
  })

  it('кто выпустил — ответственный за элемент', () => {
    // ⚠ Issue #20 просил завести у нас колонку «кто выпустил». Заводить не потребовалось:
    // ответственным элемента портал ставит того, кто нажал «выпустить», и это уже лежит
    // на портале. Инвариант «не хранить у себя то, что можно положить в портал».
    expect(readIssuedLinks({ result: { items: [portalItem()] } }, SURVEY)[0]!.assignedById).toBe(7)
  })

  it('число, присланное строкой, читается числом', () => {
    const [read] = readIssuedLinks({ result: { items: [portalItem({ [buildFieldName(SURVEY.id, 'SCORE')]: '7.5' })] } }, SURVEY)

    expect(read!.score).toBe(7.5)
    expect(read!.version).toBe(1)
  })

  it('ГЛАВНОЕ: незаполненный балл — это `null`, а не ноль', () => {
    // ⚠ Инвариант проекта на другом конце пути: «нет ответа — это `null`, а не честный ноль».
    // Ноль в списке читался бы как «клиент поставил ноль», а он просто ещё не отвечал.
    //
    // ⚠ ФОРМА ВЗЯТА С ЖИВОГО ПОРТАЛА, и в этом всё дело: незаполненный `double` приезжает
    // как `null`, а `Number(null)` в JavaScript равен нулю. Первая редакция теста проверяла
    // пустую СТРОКУ — форму, которой портал не присылает, — и дефект пережил её, зелёную.
    // Нашёл живой прогон: в списке стояло «балл 0» у анкеты без единого ответа.
    const scoreField = buildFieldName(SURVEY.id, 'SCORE')
    // Поля вовсе нет — так отвечает портал по элементу, созданному другим способом.
    const { [scoreField]: _absent, ...missing } = portalItem()

    expect(readIssuedLinks({ result: { items: [portalItem({ [scoreField]: null })] } }, SURVEY)[0]!.score).toBeNull()
    expect(readIssuedLinks({ result: { items: [missing] } }, SURVEY)[0]!.score).toBeNull()
    expect(readIssuedLinks({ result: { items: [portalItem()] } }, SURVEY)[0]!.score).toBeNull()
  })

  it('честный ноль баллов от нуля-заглушки отличается', () => {
    // Клиент МОЖЕТ поставить ноль, и такой балл обязан доехать до списка числом.
    const zero = { [buildFieldName(SURVEY.id, 'SCORE')]: '0' }

    expect(readIssuedLinks({ result: { items: [portalItem(zero)] } }, SURVEY)[0]!.score).toBe(0)
  })

  it('мусор в ответе не превращается в строки списка', () => {
    const answer = { result: { items: [null, 'строка', {}, { id: 0 }, { id: 'не число' }] } }

    expect(readIssuedLinks(answer, SURVEY)).toEqual([])
    expect(readIssuedLinks(null, SURVEY)).toEqual([])
    expect(readIssuedLinks({ result: {} }, SURVEY)).toEqual([])
  })
})

describe('состояние ссылки', () => {
  const NOW = new Date('2026-09-24T12:00:00+03:00')
  const PAST = '2026-09-01T00:00:00+03:00'

  it('ждём ответа, пока срок не вышел', () => {
    expect(issuedState(link(), NOW)).toBe('active')
  })

  it('истекла, когда срок позади', () => {
    expect(issuedState(link({ expiresAt: PAST }), NOW)).toBe('expired')
  })

  it('ГЛАВНОЕ: отозванная остаётся отозванной и после срока', () => {
    // ⚠ Порядок проверок смысловой. «Её остановили» и «её не открыли вовремя» — разные
    // ответы на вопрос «почему клиент не ответил», и при разборе инцидента вся разница
    // именно в них. Показав «истекла» на отозванной, мы стёрли бы след собственного действия.
    expect(issuedState(link({ state: SURVEY_STATE_REVOKED, expiresAt: PAST }), NOW)).toBe('revoked')
  })

  it('пройденная остаётся пройденной и после срока', () => {
    // У неё уже есть ответ клиента, и срок к ней отношения не имеет.
    expect(issuedState(link({ state: 'completed', expiresAt: PAST }), NOW)).toBe('completed')
  })

  it('без срока не выдумывает просрочку', () => {
    // Поле может быть пустым у элементов, созданных до того, как срок начали писать.
    expect(issuedState(link({ expiresAt: '' }), NOW)).toBe('active')
    expect(issuedState(link({ expiresAt: 'не дата' }), NOW)).toBe('active')
  })

  it('гасить можно только живую', () => {
    expect(isRevocable(link(), NOW)).toBe(true)
    expect(isRevocable(link({ state: 'completed' }), NOW)).toBe(false)
    expect(isRevocable(link({ state: SURVEY_STATE_REVOKED }), NOW)).toBe(false)
    expect(isRevocable(link({ expiresAt: PAST }), NOW)).toBe(false)
  })
})

describe('отзыв на портале', () => {
  const call = buildRevokeCall(SURVEY, 54)

  it('меняет ТОЛЬКО состояние', () => {
    // ⚠ Это чужая сущность: каждое лишнее поле в `fields` затирает данные клиента.
    // Отозванная ссылка обязана остаться читаемой историей — «выпустили тогда-то,
    // погасили», — иначе отзыв превращается в тихое удаление.
    expect(Object.keys(call.params.fields as Record<string, unknown>))
      .toEqual([buildFieldName(SURVEY.id, 'STATE')])
  })

  it('пишет `revoked` оригинальными именами полей', () => {
    expect(call.method).toBe('crm.item.update')
    expect(call.params.useOriginalUfNames).toBe('Y')
    expect((call.params.fields as Record<string, unknown>)[buildFieldName(SURVEY.id, 'STATE')])
      .toBe(SURVEY_STATE_REVOKED)
  })

  it('адресует элемент по `entityTypeId`, а поле — по `id`', () => {
    // ⚠ Пара, на которой проект уже обжигался: `entityTypeId` адресует элементы,
    // `id` — настройки и имена полей.
    expect(call.params.entityTypeId).toBe(SURVEY.entityTypeId)
    expect(call.params.id).toBe(54)
  })
})
