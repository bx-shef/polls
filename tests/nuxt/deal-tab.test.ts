import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { defineEventHandler, readBody } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Вкладка в карточке сделки в окружении Nuxt.
 *
 * Здесь два класса отказов, которые без смонтированного компонента не проверить: двойное
 * нажатие, выпускающее ДВЕ ссылки и два элемента смарт-процесса, и отказ, объяснённый
 * человеку не тем текстом. Второе не косметика: «попробуйте ещё раз» на отказ в доступе —
 * обман, после которого менеджер пробует, звонит в поддержку и злится.
 *
 * Фрейм подменён: настоящий `initializeB24Frame` ждёт ответа от родительского окна,
 * которого в тестовом окружении нет, и висит до таймаута.
 */

/**
 * Ровно то, что возвращает `getAuthData()` — сверено с `dist/esm/frame/auth.mjs`.
 *
 * ⚠ Здесь стояло `{ memberId, access_token }`, и это повторяло опечатку самого кода:
 * SDK отдаёт `member_id`. Подделка, согласованная с дефектом, а не с источником, —
 * это тест, доказывающий, что две ошибки совпадают. Вкладка не работала бы на живом
 * портале при зелёном прогоне. Поэтому форма здесь списана с реализации SDK, а не
 * с нашего кода, и разбор её живёт в `app/utils/frame-auth.ts` под своими тестами.
 */
const AUTH = {
  access_token: 'фреймовый-токен',
  refresh_token: 'грант',
  expires: 1789640000,
  expires_in: 3600,
  domain: 'https://shef.bitrix24.ru',
  member_id: 'a223c6b3710f85df22e9377d6c4f7553',
}

/** Что портал положил во фрейм. `ID` строкой и заглавными — ровно так, как приходит вживую. */
let placementOptions: unknown = { ID: '42' }
/** Есть ли вообще связь с порталом: `false` — SDK не смог договориться с родительским окном. */
let frameWorks = true

vi.mock('@bitrix24/b24jssdk', () => ({
  initializeB24Frame: async () => {
    if (!frameWorks) throw new Error('нет связи с порталом')
    return { placement: { options: placementOptions }, auth: { getAuthData: () => AUTH } }
  },
}))

const SURVEYS = [{ code: 'default', version: 3, title: 'Оценка работы по проекту' }]

/** Чем отвечает выпуск ссылки. Меняется сценарием, считается число обращений. */
let issueReply: unknown = { ok: true, url: 'https://опрос.рф/s/' + 'a'.repeat(43), expiresAt: '2026-10-16T00:00:00.000Z' }
let issueCalls = 0
let surveysReply: unknown = { ok: true, surveys: SURVEYS }

/** Что отдаёт список выпущенных ссылок и чем отвечает отзыв. */
let linksReply: unknown = { ok: true, links: [] }
let revokeReply: unknown = { ok: true }
/** Порядок обращений: на нём держится главный гвард перевыпуска. */
let order: string[] = []

registerEndpoint('/api/portal/surveys', defineEventHandler(async (event) => {
  await readBody(event)
  return surveysReply
}))

registerEndpoint('/api/portal/issue', defineEventHandler(async (event) => {
  await readBody(event)
  issueCalls += 1
  order.push('issue')
  return issueReply
}))

registerEndpoint('/api/portal/links', defineEventHandler(async (event) => {
  await readBody(event)
  order.push('links')
  return linksReply
}))

registerEndpoint('/api/portal/revoke', defineEventHandler(async (event) => {
  await readBody(event)
  order.push('revoke')
  return revokeReply
}))

async function openTab() {
  const DealTab = (await import('../../app/pages/portal/deal-tab.vue')).default
  return mountSuspended(DealTab, { route: '/portal/deal-tab' })
}

/** Дождаться, пока отработает `onMounted` со своими двумя ожиданиями. */
async function settle() {
  for (let tick = 0; tick < 6; tick += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

/** Одна живая ссылка в списке — то, что видит менеджер, открывший вкладку второй раз. */
const ACTIVE_LINK = {
  itemId: 54,
  title: 'Оценка работы по проекту',
  code: 'default',
  version: 3,
  state: 'active',
  expiresAt: '2026-10-16T00:00:00.000Z',
  completedAt: '',
  score: null,
}

beforeEach(() => {
  placementOptions = { ID: '42' }
  frameWorks = true
  issueCalls = 0
  linksReply = { ok: true, links: [] }
  revokeReply = { ok: true }
  order = []
  surveysReply = { ok: true, surveys: SURVEYS }
  issueReply = { ok: true, url: 'https://опрос.рф/s/' + 'a'.repeat(43), expiresAt: '2026-10-16T00:00:00.000Z' }
})

describe('вкладка в карточке сделки', () => {
  it('показывает опубликованные опросы', async () => {
    const page = await openTab()
    await settle()

    expect(page.text()).toContain('Оценка работы по проекту')
  })

  it('выпускает ссылку и показывает её целиком', async () => {
    const page = await openTab()
    await settle()

    await page.findAll('button').find(button => button.text().includes('Оценка'))!.trigger('click')
    await settle()

    expect(issueCalls).toBe(1)
    expect(page.text()).toContain('Ссылка выпущена')
    expect(page.find('input').element.value).toContain('/s/')
  })

  it('на двойное нажатие выпускает ОДНУ ссылку', async () => {
    // Каждый выпуск создаёт элемент смарт-процесса и отдельный токен. Два элемента
    // на одну сделку менеджер увидит, а вот две живые ссылки у клиента — нет.
    const page = await openTab()
    await settle()

    const button = page.findAll('button').find(candidate => candidate.text().includes('Оценка'))!
    void button.trigger('click')
    void button.trigger('click')
    await settle()

    expect(issueCalls).toBe(1)
  })

  it('на отказ в доступе к сделке не предлагает «попробовать ещё раз»', async () => {
    // Пробовать бессмысленно: сколько ни нажимай, чужую сделку не увидишь. Человеку
    // нужна причина, а не бодрое предложение повторить.
    issueReply = { ok: false, reason: 'deal-denied' }
    const page = await openTab()
    await settle()

    await page.findAll('button').find(candidate => candidate.text().includes('Оценка'))!.trigger('click')
    await settle()

    expect(page.text()).toContain('нет доступа к этой сделке')
    expect(page.text()).not.toContain('Попробуйте ещё раз')
  })

  it('различает «опрос сняли с публикации» и общую неудачу', async () => {
    issueReply = { ok: false, reason: 'survey-gone' }
    const page = await openTab()
    await settle()

    await page.findAll('button').find(candidate => candidate.text().includes('Оценка'))!.trigger('click')
    await settle()

    expect(page.text()).toContain('сняли с публикации')
  })

  it('на неизвестную причину отказа не показывает `undefined`', async () => {
    // Сервер однажды вернёт причину, о которой вкладка не знает. Показать в карточке
    // `undefined` — худшее, что можно сделать с человеком в этот момент.
    issueReply = { ok: false, reason: 'что-то-новое' }
    const page = await openTab()
    await settle()

    await page.findAll('button').find(candidate => candidate.text().includes('Оценка'))!.trigger('click')
    await settle()

    expect(page.text()).toContain('Попробуйте ещё раз')
    expect(page.text()).not.toContain('undefined')
  })

  it('без сделки в параметрах фрейма честно говорит, что сделка не определена', async () => {
    placementOptions = {}
    const page = await openTab()
    await settle()

    expect(page.text()).toContain('Сделка не определена')
  })

  it('когда портал не настроен, зовёт настраивать, а не показывает ошибку', async () => {
    surveysReply = { ok: false, reason: 'not-provisioned' }
    const page = await openTab()
    await settle()

    expect(page.text()).toContain('ещё настраивается')
  })

  it('без связи с порталом не остаётся в вечной загрузке', async () => {
    // `finally` в `onMounted` держит именно это: упавший SDK без него оставляет
    // скелет на экране навсегда, и вкладка выглядит сломанной молча.
    frameWorks = false
    const page = await openTab()
    await settle()

    expect(page.text()).toContain('Не удалось связаться с порталом')
  })

  it('показывает уже выпущенные ссылки, а не только что выпущенную', async () => {
    // ⚠ Ради этого задача и заводилась (issue #20). Закрыл вкладку — и узнать, выпускал ли
    // ты что-нибудь по этой сделке, было нельзя: сам токен не покажется больше никогда,
    // у нас лежит только его хеш.
    linksReply = { ok: true, links: [ACTIVE_LINK] }
    const page = await openTab()
    await settle()

    expect(page.text()).toContain('Выпущенные ссылки')
    expect(page.text()).toContain('Ждём ответа')
  })

  it('отзыв перечитывает список с сервера, а не правит его на месте', async () => {
    // ⚠ Состояние ссылки живёт на портале. Поправив список у себя, мы показали бы то,
    // чего там может не оказаться: отзыв мог пройти наполовину, а за время, пока вкладка
    // открыта, ссылку могли пройти.
    linksReply = { ok: true, links: [ACTIVE_LINK] }
    const page = await openTab()
    await settle()
    order = []

    await page.findAll('button').find(button => button.text().includes('Отозвать'))!.trigger('click')
    await settle()

    expect(order).toEqual(['revoke', 'links'])
  })

  it('ГЛАВНОЕ: перевыпуск гасит ПРЕЖДЕ, чем выпускает новую', async () => {
    // ⚠ Порядок — весь смысл перевыпуска. Выпусти мы сначала, и между двумя вызовами
    // по сделке живут ДВЕ рабочие одноразовые ссылки, а какая из них «настоящая»,
    // не знает никто: обе открываются, обе одноразовые. Issue #20 называет это прямо.
    linksReply = { ok: true, links: [ACTIVE_LINK] }
    const page = await openTab()
    await settle()
    order = []

    await page.findAll('button').find(button => button.text().includes('Перевыпустить'))!.trigger('click')
    await settle()

    expect(order.indexOf('revoke')).toBeLessThan(order.indexOf('issue'))
    expect(issueCalls).toBe(1)
  })

  it('не гасит прежнюю, если анкету сняли с публикации', async () => {
    // Иначе менеджер остался бы без обеих: старую погасили, новую выпустить нечем.
    linksReply = { ok: true, links: [{ ...ACTIVE_LINK, code: 'снятая', version: 9 }] }
    const page = await openTab()
    await settle()
    order = []

    await page.findAll('button').find(button => button.text().includes('Перевыпустить'))!.trigger('click')
    await settle()

    expect(order).toEqual([])
    expect(page.text()).toContain('сняли с публикации')
  })

  it('упавший список не мешает выпустить ссылку', async () => {
    // Список — память о прошлом, выпуск — работа, за которой человек пришёл. Уронив вкладку
    // из-за первого, мы отняли бы второе.
    linksReply = { ok: false, reason: 'not-provisioned' }
    const page = await openTab()
    await settle()

    await page.findAll('button').find(button => button.text().includes('Оценка'))!.trigger('click')
    await settle()

    expect(issueCalls).toBe(1)
    expect(page.text()).toContain('Ссылка выпущена')
  })
})
