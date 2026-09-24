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

registerEndpoint('/api/portal/surveys', defineEventHandler(async (event) => {
  await readBody(event)
  return surveysReply
}))

registerEndpoint('/api/portal/issue', defineEventHandler(async (event) => {
  await readBody(event)
  issueCalls += 1
  return issueReply
}))

async function openTab() {
  const DealTab = (await import('../../app/pages/portal/deal-tab.vue')).default
  return mountSuspended(DealTab, { route: '/portal/deal-tab' })
}

/** Дождаться, пока отработает `onMounted` со своими двумя ожиданиями. */
async function settle() {
  for (let tick = 0; tick < 6; tick += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
  placementOptions = { ID: '42' }
  frameWorks = true
  issueCalls = 0
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

  it('снаружи портала показывает заглушку, а не интерфейс (issue #29)', async () => {
    // ⚠ Здесь стоял прежний текст «Не удалось связаться с порталом. Обновите страницу» —
    // совет, который снаружи портала не может сработать в принципе: страница открыта
    // не оттуда, а не потому, что портал молчит. Человек обновлял бы её до потери терпения.
    //
    // ⚠ Главное утверждение — ВТОРАЯ половина: ничего рабочего снаружи не показано.
    // Ошибка гейта в пользу «показать» выглядит как исправная страница и потому тихая:
    // кнопки на месте, ничего не падает, просто ничего не работает.
    frameWorks = false
    const page = await openTab()
    await settle()

    expect(page.text()).toContain('Откройте вкладку из Битрикс24')
    expect(page.text()).not.toContain('Оценка работы по проекту')
    expect(page.findAll('button')).toHaveLength(0)
  })

  it('и всё-таки не остаётся в вечной загрузке', async () => {
    // `finally` в `onMounted` держит именно это: упавший SDK без него оставляет скелет
    // на экране навсегда, и вкладка выглядит сломанной молча. Гейт этого не отменяет —
    // он решает, ЧТО показать, а не показать ли вообще.
    frameWorks = false
    const page = await openTab()
    await settle()

    expect(page.find('.b24ui-skeleton').exists()).toBe(false)
  })

  it('на `?preview=1` показывает интерфейс и снаружи портала', async () => {
    frameWorks = false
    const DealTab = (await import('../../app/pages/portal/deal-tab.vue')).default
    const page = await mountSuspended(DealTab, { route: '/portal/deal-tab?preview=1&ID=42' })
    await settle()

    expect(page.text()).not.toContain('Откройте вкладку из Битрикс24')
  })
})
