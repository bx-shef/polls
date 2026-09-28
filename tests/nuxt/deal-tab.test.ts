import { registerEndpoint } from '@nuxt/test-utils/runtime'
import { defineEventHandler, readBody } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountInShell } from './in-shell'

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
 *
 * Вкладка монтируется внутри `AppShell`, как её рисует layout `portal`: значку справки нужен
 * `<B24App>` над ним — разбор в `./in-shell.ts`.
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

/** Что выдаёт окно портала на продление: тот же пропуск с новым токеном. */
const RENEWED = { ...AUTH, access_token: 'продлённый-токен' }

/** Что портал положил во фрейм. `ID` строкой и заглавными — ровно так, как приходит вживую. */
let placementOptions: unknown = { ID: '42' }
/** Есть ли вообще связь с порталом: `false` — SDK не смог договориться с родительским окном. */
let frameWorks = true
/**
 * Что сейчас отдаёт `getAuthData()`. `false` — токен прожил свой час: ровно так отвечает SDK
 * (`dist/esm/frame/auth.mjs`), пока его не продлят вызовом `refreshAuth()`.
 */
let authData: unknown = AUTH

vi.mock('@bitrix24/b24jssdk', () => ({
  initializeB24Frame: async () => {
    if (!frameWorks) throw new Error('нет связи с порталом')
    return {
      placement: { options: placementOptions },
      auth: {
        getAuthData: () => authData,
        // Как у SDK: ответ окна портала приходит не сразу, и новый токен запоминается у себя.
        refreshAuth: async () => {
          await new Promise(resolve => setTimeout(resolve, 0))
          authData = RENEWED
          return RENEWED
        },
      },
    }
  },
}))

const SURVEYS = [{ code: 'default', version: 3, title: 'Оценка работы по проекту', sections: 2, questions: 5 }]
/** Ключ карточки — `код:версия`, как его строит вкладка. */
const SURVEY_KEY = 'default:3'
/** Неразрывный пробел — кодом символа, как и во вкладке: в исходнике сам символ не виден. */
const NBSP = String.fromCharCode(0xA0)
const URL = 'https://опрос.рф/s/' + 'a'.repeat(43)

/** Чем отвечает выпуск ссылки. Меняется сценарием, считается число обращений. */
let issueReply: unknown = { ok: true, url: URL, expiresAt: '2026-10-16T00:00:00.000Z' }
let issueCalls = 0
let surveysReply: unknown = { ok: true, surveys: SURVEYS }
/** Роут списка анкет упал целиком: сеть, 500, отвалившийся портал. */
let surveysThrows = false

/** Что отдаёт список выпущенных ссылок и чем отвечает отзыв. */
let linksReply: unknown = { ok: true, links: [] }
let revokeReply: unknown = { ok: true }
/** Роут списка ссылок упал целиком — 503 «портал недоступен», 429 ограничителя частоты. */
let linksThrows = false
/** Пока не разрешён, список ссылок не отвечает: так проверяется, что перечитка ждёт ОБА ответа. */
let linksGate: Promise<void> | null = null
/** Порядок обращений: на нём держится главный гвард перевыпуска. */
let order: string[] = []
/** Последнее тело каждого роута: что именно вкладка отправила на сервер. */
let bodies: Record<string, Record<string, unknown>> = {}

registerEndpoint('/api/portal/surveys', defineEventHandler(async (event) => {
  bodies.surveys = await readBody(event)
  order.push('surveys')
  if (surveysThrows) throw new Error('портал недоступен')
  return surveysReply
}))

registerEndpoint('/api/portal/issue', defineEventHandler(async (event) => {
  bodies.issue = await readBody(event)
  issueCalls += 1
  order.push('issue')
  return issueReply
}))

registerEndpoint('/api/portal/links', defineEventHandler(async (event) => {
  bodies.links = await readBody(event)
  order.push('links')
  if (linksGate !== null) await linksGate
  if (linksThrows) throw new Error('портал недоступен')
  return linksReply
}))

registerEndpoint('/api/portal/revoke', defineEventHandler(async (event) => {
  bodies.revoke = await readBody(event)
  order.push('revoke')
  return revokeReply
}))

async function openTab(route = '/portal/deal-tab') {
  const DealTab = (await import('../../app/pages/portal/deal-tab.vue')).default
  return mountInShell(DealTab, { route })
}

type Tab = Awaited<ReturnType<typeof openTab>>

/** Дождаться, пока отработает `onMounted` со своими двумя ожиданиями. */
async function settle() {
  for (let tick = 0; tick < 6; tick += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

/** Кнопка по подписи. Ищем по тексту: его видит человек, а не по классу. */
function button(page: Tab, label: string) {
  return page.findAll('button').find(candidate => candidate.text().includes(label))
}

/** Выбрать карточку анкеты — первый из двух шагов выпуска. */
async function pick(page: Tab, key = SURVEY_KEY) {
  await page.find(`input[type="radio"][value="${key}"]`).setValue(true)
}

/** Выбрать анкету и нажать «Выпустить ссылку» — оба шага, как у человека. */
async function issueLink(page: Tab) {
  await pick(page)
  await page.find('[data-testid="issue"]').trigger('click')
  await settle()
}

/** Одна живая ссылка в списке — то, что видит менеджер, открывший вкладку второй раз. */
const ACTIVE_LINK = {
  itemId: 54,
  title: 'Оценка работы по проекту — Сделка с ООО «Ромашка»',
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
  authData = AUTH
  issueCalls = 0
  linksReply = { ok: true, links: [] }
  linksThrows = false
  linksGate = null
  revokeReply = { ok: true }
  order = []
  bodies = {}
  surveysReply = { ok: true, surveys: SURVEYS }
  surveysThrows = false
  issueReply = { ok: true, url: URL, expiresAt: '2026-10-16T00:00:00.000Z' }
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

    await issueLink(page)

    expect(issueCalls).toBe(1)
    expect(page.text()).toContain('Ссылка выпущена')
    expect((page.find('[data-testid="issued"] input').element as HTMLInputElement).value).toBe(URL)
  })

  it('на двойное нажатие выпускает ОДНУ ссылку', async () => {
    // Каждый выпуск создаёт элемент смарт-процесса и отдельный токен. Два элемента
    // на одну сделку менеджер увидит, а вот две живые ссылки у клиента — нет.
    const page = await openTab()
    await settle()
    await pick(page)

    const issue = page.find('[data-testid="issue"]')
    void issue.trigger('click')
    void issue.trigger('click')
    await settle()

    expect(issueCalls).toBe(1)
  })

  it('на отказ в доступе к сделке не предлагает «попробовать ещё раз»', async () => {
    // Пробовать бессмысленно: сколько ни нажимай, чужую сделку не увидишь. Человеку
    // нужна причина, а не бодрое предложение повторить.
    issueReply = { ok: false, reason: 'deal-denied' }
    const page = await openTab()
    await settle()

    await issueLink(page)

    expect(page.text()).toContain('нет доступа к этой сделке')
    expect(page.text()).not.toContain('Попробуйте ещё раз')
  })

  it('различает «опрос сняли с публикации» и общую неудачу', async () => {
    issueReply = { ok: false, reason: 'survey-gone' }
    const page = await openTab()
    await settle()

    await issueLink(page)

    expect(page.text()).toContain('сняли с публикации')
  })

  it('на неизвестную причину отказа не показывает `undefined`', async () => {
    // Сервер однажды вернёт причину, о которой вкладка не знает. Показать в карточке
    // `undefined` — худшее, что можно сделать с человеком в этот момент.
    issueReply = { ok: false, reason: 'что-то-новое' }
    const page = await openTab()
    await settle()

    await issueLink(page)

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
    // кнопки на месте, ничего не падает, просто ничего не работает. «Обновить» в шапке
    // сюда тоже относится: перечитывать снаружи портала нечем.
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
    const page = await openTab('/portal/deal-tab?preview=1&ID=42')
    await settle()

    expect(page.text()).not.toContain('Откройте вкладку из Битрикс24')
  })
})

describe('выбор анкеты — карточками, выпуск — кнопкой (issue #84, п. 2)', () => {
  it('ГЛАВНОЕ: карточка только выбирает, ссылку выпускает кнопка', async () => {
    // ⚠ Раньше анкета была кнопкой, и случайное нажатие СРАЗУ выпускало ссылку: элемент
    // «Опроса» в CRM клиента и живой токен, которые не отменить. Выбор ничего не выпускает,
    // а кнопка выпуска неактивна, пока ничего не выбрано.
    const page = await openTab()
    await settle()

    expect(page.find('[data-testid="issue"]').attributes('disabled')).toBeDefined()

    await pick(page)
    await settle()

    expect(issueCalls).toBe(0)
    expect(page.find('[data-testid="issue"]').attributes('disabled')).toBeUndefined()
  })

  it('под названием — версия и сколько в анкете разделов и вопросов', async () => {
    // По этой строчке менеджер различает анкеты с похожими названиями. Числа считает сервер.
    const page = await openTab()
    await settle()

    // Между числом и словом неразрывный пробел: переносится строка только по « · ».
    expect(page.text()).toContain(`версия${NBSP}3 · 2${NBSP}раздела · 5${NBSP}вопросов`)
  })

  it('выпускает по той карточке, которую выбрали, — её код и её версию', async () => {
    // Выбор хранит ключ `код:версия`, анкету по нему находит общая таблица `surveyByKey`.
    // С одной карточкой на экране ошибку «взяли не ту» не поймать: выпустилась бы единственная.
    // Перепутай вкладка карточки — клиент заполнял бы чужую анкету. Попросил тестировщик PR #89.
    surveysReply = { ok: true, surveys: [...SURVEYS, { code: 'brand', version: 1, title: 'Оценка бренда', sections: 1, questions: 3 }] }
    const page = await openTab()
    await settle()

    await pick(page, 'brand:1')
    await page.find('[data-testid="issue"]').trigger('click')
    await settle()

    expect(bodies.issue).toMatchObject({ dealId: 42, surveyCode: 'brand', surveyVersion: 1 })
    expect(page.find('[data-testid="issued"]').text()).toContain('«Оценка бренда»')
  })

  it('следующую ссылку выбирают заново, прежний выбор не остаётся', async () => {
    // Оставшийся выбор превратил бы привычное нажатие «Выпустить ссылку» в лишний выпуск.
    const page = await openTab()
    await settle()
    await issueLink(page)

    await button(page, 'Выпустить ещё одну')!.trigger('click')
    await settle()

    expect(page.find('[data-testid="issue"]').attributes('disabled')).toBeDefined()
  })

  it('отказ выпуска не прячет ни выбор, ни список', async () => {
    // ⚠ Раньше любой отказ вставал ВМЕСТО всего содержимого, и совет «выберите другую анкету»
    // показывался там, где выбирать было уже не из чего.
    issueReply = { ok: false, reason: 'deal-denied' }
    linksReply = { ok: true, links: [ACTIVE_LINK] }
    const page = await openTab()
    await settle()

    await issueLink(page)

    expect(page.find('[data-testid="refusal"]').exists()).toBe(true)
    expect(page.find('[data-testid="issue"]').exists()).toBe(true)
    expect(page.find('[data-testid="issued-links"]').exists()).toBe(true)
  })

  it('отказ выпуска — у кнопки выпуска, а не над списком', async () => {
    // ⚠ Под сеткой из дюжины карточек плашка над списком уезжает за верх вкладки: нажатие
    // «Выпустить ссылку» выглядело бы так, будто не случилось ничего.
    issueReply = { ok: false, reason: 'deal-denied' }
    linksReply = { ok: true, links: [ACTIVE_LINK] }
    const page = await openTab()
    await settle()

    await issueLink(page)

    expect(page.findAll('[data-testid="refusal"]')).toHaveLength(1)
    expect(page.find('[data-testid="picker"] [data-testid="refusal"]').exists()).toBe(true)
  })

  it('отказ перевыпуска — над списком, где его нажимали, даже когда отказал выпуск', async () => {
    issueReply = { ok: false, reason: 'что-то-новое' }
    linksReply = { ok: true, links: [ACTIVE_LINK] }
    const page = await openTab()
    await settle()

    await button(page, 'Перевыпустить')!.trigger('click')
    await settle()

    expect(page.findAll('[data-testid="refusal"]')).toHaveLength(1)
    expect(page.find('[data-testid="picker"] [data-testid="refusal"]').exists()).toBe(false)
  })
})

describe('«Обновить» (issue #84, п. 1)', () => {
  it('ГЛАВНОЕ: перечитывает ОБА списка — и видно, что клиент ответил', async () => {
    // Вкладка читает списки при открытии. Клиент ответил, пока она открыта, — без перечитки
    // «Ждём ответа» так и висело бы до переоткрытия сделки.
    linksReply = { ok: true, links: [ACTIVE_LINK] }
    const page = await openTab()
    await settle()
    order = []
    linksReply = { ok: true, links: [{ ...ACTIVE_LINK, state: 'completed', completedAt: '2026-09-28T10:00:00.000Z', score: 7.5 }] }

    await page.find('[data-testid="refresh"]').trigger('click')
    await settle()

    expect([...order].sort()).toEqual(['links', 'surveys'])
    expect(page.text()).toContain('Пройдена')
    expect(page.text()).toContain('балл 7,5')
  })

  it('не убирает только что выпущенную ссылку', async () => {
    // ⚠ У нас лежит только хеш токена, а в CRM адрес попадает не всегда: запись последним шагом
    // выпуска может не пройти, а на порталах до #87 поля «Ссылка на анкету» в карточке нет.
    // Перечитка, смахнувшая адрес с экрана, отняла бы самое удобное место его скопировать.
    const page = await openTab()
    await settle()
    await issueLink(page)

    await page.find('[data-testid="refresh"]').trigger('click')
    await settle()

    expect((page.find('[data-testid="issued"] input').element as HTMLInputElement).value).toBe(URL)
  })

  it('не убирает её и когда перечитка сорвалась — прежние списки остаются', async () => {
    // ⚠ Отказ первой загрузки встаёт ВМЕСТО содержимого: показать нечего. Отказ перечитки так
    // делать не может — под ним адрес, который больше не покажется. Он встаёт над списками.
    const page = await openTab()
    await settle()
    await issueLink(page)
    surveysThrows = true

    await page.find('[data-testid="refresh"]').trigger('click')
    await settle()

    expect((page.find('[data-testid="issued"] input').element as HTMLInputElement).value).toBe(URL)
    expect(page.find('[data-testid="failure"]').exists()).toBe(false)
    expect(page.find('[data-testid="refusal"]').findAll('button').map(candidate => candidate.text())).toContain('Обновить')
  })

  it('не убирает её и когда перечитка вернула «ещё настраивается»', async () => {
    // Администратор переустанавливает приложение, пока вкладка открыта. Карточка выпуска стояла
    // веткой той же цепочки, что и «ещё настраивается», и пряталась вместе с выбором.
    // Нашли `/review` и `/code-review` в PR #89.
    const page = await openTab()
    await settle()
    await issueLink(page)
    surveysReply = { ok: false, reason: 'not-provisioned' }

    await page.find('[data-testid="refresh"]').trigger('click')
    await settle()

    expect(page.text()).toContain('ещё настраивается')
    expect((page.find('[data-testid="issued"] input').element as HTMLInputElement).value).toBe(URL)
  })

  it('ГЛАВНОЕ: перечитка кончается, только когда пришли ОБА ответа', async () => {
    // ⚠ `Promise.all` отдавал управление на первом отказе: кнопки снова активны, а второй запрос
    // ещё идёт — и его поздний ответ затирал список, прочитанный уже после выпуска: ссылки,
    // выпущенной секунду назад, в нём нет. Нашли `/review` и `/code-review` в PR #89.
    const page = await openTab()
    await settle()
    let release!: () => void
    linksGate = new Promise<void>((resolve) => {
      release = resolve
    })
    surveysThrows = true

    await page.find('[data-testid="refresh"]').trigger('click')
    await settle()

    expect(page.find('[data-testid="refresh"]').attributes('disabled')).toBeDefined()

    release()
    await settle()

    expect(page.find('[data-testid="refresh"]').attributes('disabled')).toBeUndefined()
    expect(page.find('[data-testid="refusal"]').text()).toContain('могут быть устаревшими')
  })

  it('повторный отказ первой загрузки говорит о себе иначе — временем попытки', async () => {
    // ⚠ Плашка, слово в слово прежняя после нажатия «Обновить», неотличима от кнопки, которая
    // не сработала, — та самая немая кнопка. Нашли `/review` и `/code-review` в PR #89.
    surveysThrows = true
    const page = await openTab()
    await settle()
    const before = page.find('[data-testid="failure"]').text()

    await page.find('[data-testid="failure"]').findAll('button').find(candidate => candidate.text() === 'Обновить')!.trigger('click')
    await settle()

    expect(before).not.toContain('Последняя попытка')
    expect(page.find('[data-testid="failure"]').text()).toContain('Последняя попытка')
  })

  it('«опросов пока нет» — с кнопкой «Обновить» в самой плашке', async () => {
    // Совет «опубликуйте и нажмите «Обновить»»: на узком экране в шапке «Обновить» — только
    // значок, и без кнопки рядом совет было бы нечем выполнить. Нашёл `/review` в PR #89.
    surveysReply = { ok: true, surveys: [] }
    const page = await openTab()
    await settle()

    const empty = page.find('[data-testid="no-surveys"]')
    expect(empty.findAll('button').map(candidate => candidate.text())).toContain('Обновить')
  })

  it('не убирает её и когда выпускать больше не по чему', async () => {
    // Анкету сняли с публикации, пока вкладка открыта: выбор уступает место «опросов пока нет»,
    // а адрес остаётся — и «выпустить ещё одну» не предлагается, выпускать не по чему.
    const page = await openTab()
    await settle()
    await issueLink(page)
    surveysReply = { ok: true, surveys: [] }

    await page.find('[data-testid="refresh"]').trigger('click')
    await settle()

    expect(page.text()).toContain('Опросов пока нет')
    expect((page.find('[data-testid="issued"] input').element as HTMLInputElement).value).toBe(URL)
    expect(button(page, 'Выпустить ещё одну')).toBeUndefined()
  })

  it('список не пришёл — в плашке кнопка «Обновить», а не совет обновить страницу', async () => {
    // ⚠ Одну вкладку внутри карточки портала обновить нельзя — только переоткрыть сделку.
    // Совет «Обновите страницу» было нечем выполнить.
    surveysThrows = true
    const page = await openTab()
    await settle()

    const failure = page.find('[data-testid="failure"]')
    expect(failure.text()).not.toContain('Обновите страницу')
    surveysThrows = false

    // Кнопка именно В ПЛАШКЕ, рядом с текстом, — «Обновить» в шапке тут не в счёт.
    await failure.findAll('button').find(candidate => candidate.text() === 'Обновить')!.trigger('click')
    await settle()

    expect(page.find('[data-testid="failure"]').exists()).toBe(false)
    expect(page.text()).toContain('Оценка работы по проекту')
  })

  it('«снят с публикации» приходит с кнопкой «Обновить» в самой плашке', async () => {
    issueReply = { ok: false, reason: 'survey-gone' }
    const page = await openTab()
    await settle()
    await issueLink(page)

    expect(page.find('[data-testid="refusal"]').text()).not.toContain('Обновите страницу')
    expect(page.find('[data-testid="refusal"]').findAll('button').map(candidate => candidate.text())).toContain('Обновить')
  })

  it('после доустановки убирает «ещё настраивается»', async () => {
    // Признак ставится заново на каждой перечитке, а не только поднимается: иначе вкладка
    // говорила бы «ещё настраивается» до переоткрытия сделки.
    surveysReply = { ok: false, reason: 'not-provisioned' }
    const page = await openTab()
    await settle()
    surveysReply = { ok: true, surveys: SURVEYS }

    await page.find('[data-testid="refresh"]').trigger('click')
    await settle()

    expect(page.text()).not.toContain('ещё настраивается')
    expect(page.text()).toContain('Оценка работы по проекту')
  })

  it('без сделки кнопки нет: перечитка сделку не найдёт', async () => {
    placementOptions = {}
    const page = await openTab()
    await settle()

    expect(page.find('[data-testid="refresh"]').exists()).toBe(false)
  })
})

describe('выпущенные ссылки', () => {
  it('показывает уже выпущенные ссылки, а не только что выпущенную', async () => {
    // ⚠ Ради этого задача и заводилась (issue #20). Закрыл вкладку — и узнать, выпускал ли
    // ты что-нибудь по этой сделке, было нельзя.
    linksReply = { ok: true, links: [ACTIVE_LINK] }
    const page = await openTab()
    await settle()

    expect(page.text()).toContain('Выпущенные ссылки')
    expect(page.text()).toContain('Ждём ответа')
  })

  it('строка называет анкету, а не сделку (issue #84, п. 3)', async () => {
    // Заголовок элемента — «анкета — сделка». Во вкладке этой же сделки её название
    // повторяет то, что человек и так видит, и растягивает строку.
    linksReply = { ok: true, links: [ACTIVE_LINK] }
    const page = await openTab()
    await settle()

    const row = page.find('[data-testid="issued-link"]')
    expect(row.text()).toContain('Оценка работы по проекту')
    expect(row.text()).not.toContain('Ромашка')
  })

  it('отозванная и истёкшая — своими словами и без кнопок; дата — только у истёкшей', async () => {
    // «Отозвана» — действие человека, «Истекла» — течение времени, и при разборе «почему клиент
    // не ответил» разница между ними и есть весь ответ. Когда ссылку отозвали, портал не хранит:
    // дата у отозванной была бы сроком, который уже ничего не значит. Середина дня, а не полночь, —
    // чтобы дата не зависела от часового пояса машины. Попросил тестировщик PR #89.
    const noon = '2026-10-16T12:00:00.000Z'
    linksReply = { ok: true, links: [
      { ...ACTIVE_LINK, itemId: 55, state: 'revoked', expiresAt: noon },
      { ...ACTIVE_LINK, itemId: 56, state: 'expired', expiresAt: noon },
      { ...ACTIVE_LINK, itemId: 57, state: 'completed', completedAt: '2026-09-28T12:00:00.000Z', score: null },
    ] }
    const page = await openTab()
    await settle()

    const [revoked, expired, completed] = page.findAll('[data-testid="issued-link"]')
    expect(revoked!.text()).toContain('Отозвана')
    expect(revoked!.text()).not.toContain('октября')
    expect(expired!.text()).toContain('Истекла')
    expect(expired!.text()).toContain('истекла 16 октября 2026 г.')
    // Пройдена без балла — дата есть, «балл» не выдуман.
    expect(completed!.text()).toContain('пройдена 28 сентября 2026 г.')
    expect(completed!.text()).not.toContain('балл')
    for (const row of [revoked!, expired!, completed!]) expect(row.findAll('button')).toHaveLength(0)
  })

  it('ГЛАВНОЕ: сорвавшаяся перечитка не стирает список — «ничего не выпускали» было бы неправдой', async () => {
    // ⚠ Прежде любой отказ — 503 «портал недоступен», 429 ограничителя частоты — молча ставил
    // пустой список, и раздел «Выпущенные ссылки» исчезал: менеджер решал, что по сделке ничего
    // не выпускали, и выпускал вторую живую ссылку. Нашли `/review` и `/code-review` в PR #89.
    linksReply = { ok: true, links: [ACTIVE_LINK] }
    const page = await openTab()
    await settle()
    linksThrows = true

    await page.find('[data-testid="refresh"]').trigger('click')
    await settle()

    expect(page.findAll('[data-testid="issued-link"]')).toHaveLength(1)
    expect(page.find('[data-testid="refusal"]').text()).toContain('могут быть устаревшими')
  })

  it('список не пришёл при открытии — сказано, что ссылки могли выпускать', async () => {
    // Списка на экране нет вовсе, и пустое место читается как «по сделке ничего не выпускали».
    // «На экране они могут быть устаревшими» здесь было бы не о чем: экран пуст.
    linksThrows = true
    const page = await openTab()
    await settle()

    const refusal = page.find('[data-testid="refusal"]')
    expect(refusal.text()).toContain('могли выпускать')
    expect(refusal.findAll('button').map(candidate => candidate.text())).toContain('Обновить')
    // Выбор анкеты на месте: выпуск — работа, за которой человек пришёл.
    expect(page.find('[data-testid="issue"]').exists()).toBe(true)
  })

  it('на двойное нажатие «Отозвать» — один отзыв', async () => {
    // ⚠ Кнопки гасятся перерисовкой, а второе нажатие в том же такте её не ждёт: защищаться
    // обязана сама функция, как у выпуска. Второй отзыв — лишний запрос в лимиты REST клиента
    // и второй ответ поверх первого. Нашли `/review` и `/code-review` в PR #89.
    linksReply = { ok: true, links: [ACTIVE_LINK] }
    const page = await openTab()
    await settle()
    order = []

    const revoke = button(page, 'Отозвать')!
    void revoke.trigger('click')
    void revoke.trigger('click')
    await settle()

    expect(order.filter(step => step === 'revoke')).toHaveLength(1)
  })

  it('анкеты нет среди опубликованных — строка называет её кодом', async () => {
    linksReply = { ok: true, links: [{ ...ACTIVE_LINK, code: 'brand', version: 1 }] }
    const page = await openTab()
    await settle()

    expect(page.find('[data-testid="issued-link"]').text()).toContain('brand')
  })

  it('отзыв перечитывает список с сервера, а не правит его на месте', async () => {
    // ⚠ Состояние ссылки живёт на портале. Поправив список у себя, мы показали бы то,
    // чего там может не оказаться: отзыв мог пройти наполовину, а за время, пока вкладка
    // открыта, ссылку могли пройти.
    linksReply = { ok: true, links: [ACTIVE_LINK] }
    const page = await openTab()
    await settle()
    order = []

    await button(page, 'Отозвать')!.trigger('click')
    await settle()

    expect(order).toEqual(['revoke', 'links'])
    // Гасится именно эта ссылка этой сделки. Пока подделки роутов тел не читали, отзыв с чужим
    // номером элемента проходил зелёным — заметил тестировщик PR #89.
    expect(bodies.revoke).toMatchObject({ dealId: 42, itemId: 54 })
  })

  it('ГЛАВНОЕ: перевыпуск гасит ПРЕЖДЕ, чем выпускает новую', async () => {
    // ⚠ Порядок — весь смысл перевыпуска. Выпусти мы сначала, и между двумя вызовами
    // по сделке живут ДВЕ рабочие одноразовые ссылки, а какая из них «настоящая»,
    // не знает никто: обе открываются, обе одноразовые. Issue #20 называет это прямо.
    linksReply = { ok: true, links: [ACTIVE_LINK] }
    const page = await openTab()
    await settle()
    order = []

    await button(page, 'Перевыпустить')!.trigger('click')
    await settle()

    expect(order.indexOf('revoke')).toBeLessThan(order.indexOf('issue'))
    expect(issueCalls).toBe(1)
    expect(page.text()).toContain('Ссылка выпущена')
  })

  it('не гасит прежнюю, если анкету сняли с публикации', async () => {
    // Иначе менеджер остался бы без обеих: старую погасили, новую выпустить нечем.
    linksReply = { ok: true, links: [{ ...ACTIVE_LINK, code: 'снятая', version: 9 }] }
    const page = await openTab()
    await settle()
    order = []

    await button(page, 'Перевыпустить')!.trigger('click')
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

    await issueLink(page)

    expect(issueCalls).toBe(1)
    expect(page.text()).toContain('Ссылка выпущена')
  })
})

describe('фреймовый токен прожил час (PR #89)', () => {
  it('ГЛАВНОЕ: вкладка продлевает токен у портала, а не отказывает навсегда', async () => {
    // ⚠ `getAuthData()` отдаёт `false`, как только токен прожил час, а вкладка читала пропуск
    // только им: «Обновить», выпуск, отзыв на вкладке, открытой дольше часа, отказывали до
    // переоткрытия сделки. Нашли `/review` и `/code-review` в PR #89.
    linksReply = { ok: true, links: [ACTIVE_LINK] }
    const page = await openTab()
    await settle()
    authData = false

    await page.find('[data-testid="refresh"]').trigger('click')
    await settle()

    expect(bodies.surveys!.authId).toBe('продлённый-токен')
    expect(bodies.links!.authId).toBe('продлённый-токен')
    expect(page.find('[data-testid="refusal"]').exists()).toBe(false)
  })

  it('и выпускает ссылку с продлённым токеном', async () => {
    const page = await openTab()
    await settle()
    authData = false

    await issueLink(page)

    expect(bodies.issue!.authId).toBe('продлённый-токен')
    expect(page.text()).toContain('Ссылка выпущена')
  })
})

describe('копирование адреса во фрейме портала (issue #84, п. 4)', () => {
  /** Отвечает ли `execCommand('copy')` успехом — запасной путь помощника. */
  let execCopies: boolean

  beforeEach(() => {
    execCopies = true
    // Так видит буфер приложение во фрейме портала: без `clipboard-write` Clipboard API отказывает.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new DOMException('Write permission denied.', 'NotAllowedError') } },
    })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => execCopies })
  })

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard')
    Reflect.deleteProperty(document, 'execCommand')
  })

  async function issueAndCopy() {
    const page = await openTab()
    await settle()
    await issueLink(page)
    await page.find('[data-testid="copy"]').trigger('click')
    await settle()
    return page
  }

  it('ГЛАВНОЕ: буфер закрыт, а адрес всё равно скопирован — и сказано «Скопировано»', async () => {
    // ⚠ Прежняя кнопка звала `navigator.clipboard` напрямую и глотала отказ: внутри портала
    // нажатие не давало ничего. Кнопка — значок, поэтому «Скопировано» проверяется там, где его
    // узнаёт человек: строкой под полем и именем кнопки для диктора.
    const page = await issueAndCopy()

    expect(page.find('[data-testid="copy-status"]').text()).toContain('Скопировано')
    expect(page.find('[data-testid="copy"]').attributes('aria-label')).toBe('Скопировано')
  })

  it('строка о копировании стоит в разметке ещё до нажатия', async () => {
    // ⚠ Живую область (`role="status"`), появившуюся уже с текстом, экранные дикторы часто
    // не зачитывают, а кнопка — только значок: человек с диктором не узнал бы, скопировалось ли.
    // Нашли `/review` и `/code-review` в PR #89.
    const page = await openTab()
    await settle()
    await issueLink(page)

    const status = page.find('[data-testid="copy-status"]')
    expect(status.exists()).toBe(true)
    expect(status.attributes('role')).toBe('status')
    expect(status.text()).toBe('')
  })

  it('«Скопировано» от прошлой ссылки не переезжает на следующую', async () => {
    // В буфере лежит прежний адрес. «Скопировано» у новой ссылки было бы неправдой, и клиенту
    // ушла бы прежняя — уже, может быть, отозванная. Попросил тестировщик PR #89.
    const page = await issueAndCopy()
    expect(page.find('[data-testid="copy-status"]').text()).toContain('Скопировано')

    await button(page, 'Выпустить ещё одну')!.trigger('click')
    await issueLink(page)

    expect(page.find('[data-testid="copy-status"]').text()).toBe('')
    expect(page.find('[data-testid="copy"]').attributes('aria-label')).toBe('Скопировать ссылку')
  })

  it('не копируется никак — адрес выделен, и сказано нажать Ctrl+C', async () => {
    // Молчание здесь выглядело бы как поломка, а выделенный адрес — половина работы за человека.
    execCopies = false
    const page = await issueAndCopy()

    const input = page.find('[data-testid="issued"] input').element as HTMLInputElement
    expect(page.find('[data-testid="copy-status"]').text()).toContain('Ctrl+C')
    expect(page.find('[data-testid="copy"]').attributes('aria-label')).toBe('Скопировать ссылку')
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, URL.length])
  })
})
