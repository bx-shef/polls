import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { defineEventHandler, readBody } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Страница приложения (`/app`) в окружении Nuxt.
 *
 * Это первое, что видит сотрудник, открыв «Опросы клиентов» в левом меню портала, — и до
 * панели ревью PR #28 на неё не было ни одного теста: были покрыты чистые функции гейта,
 * а сам компонент, который их использует, не монтировался ни разу.
 *
 * Здесь три класса отказов, которые без смонтированного компонента не проверить:
 *
 * 1. **Гейт ошибся в пользу «показать».** В `app/utils/in-portal.ts` про это написано прямо:
 *    показать интерфейс снаружи портала — это пустая панель, которую человек читает
 *    как поломку. Ошибка здесь тихая и выглядит работающей.
 * 2. **Отказ портала выдан за пустоту.** Ветка `ok: false` с незнакомой причиной раньше
 *    проваливалась мимо всех проверок, и страница сообщала «опубликованных анкет пока нет» —
 *    ложное утверждение о портале клиента, неотличимое от честной пустоты.
 * 3. **Разъехавшийся контракт с `/api/portal/surveys`.** Форма ответа проверяется здесь,
 *    а не типами: типы сверяют наше объявление с нашим же ожиданием.
 *
 * Фрейм подменён: настоящий `initializeB24Frame` ждёт ответа от родительского окна,
 * которого в тестовом окружении нет, и висит до таймаута.
 */

/**
 * Ровно то, что возвращает `getAuthData()` — сверено с `dist/esm/frame/auth.mjs`.
 *
 * ⚠ Списано с реализации SDK, а НЕ с нашего кода. В `deal-tab.test.ts` подделка однажды
 * повторила опечатку кода (`memberId` вместо `member_id`), и тест доказывал, что две
 * ошибки согласованы друг с другом, пока вкладка не работала бы на живом портале.
 */
const AUTH = {
  access_token: 'фреймовый-токен',
  refresh_token: 'грант',
  expires: 1789640000,
  expires_in: 3600,
  domain: 'https://shef.bitrix24.ru',
  member_id: 'a223c6b3710f85df22e9377d6c4f7553',
}

/** Есть ли связь с порталом: `false` — SDK не смог договориться с родительским окном. */
let frameWorks = true

vi.mock('@bitrix24/b24jssdk', () => ({
  initializeB24Frame: async () => {
    if (!frameWorks) throw new Error('нет связи с порталом')
    return { auth: { getAuthData: () => AUTH } }
  },
}))

const SURVEYS = [{ code: 'default', version: 3, title: 'Оценка работы по проекту' }]

let surveysReply: unknown = { ok: true, surveys: SURVEYS }
/** Роут упал целиком: сеть, 500, отвалившийся портал. */
let surveysThrows = false

registerEndpoint('/api/portal/surveys', defineEventHandler(async (event) => {
  await readBody(event)
  if (surveysThrows) throw new Error('портал недоступен')
  return surveysReply
}))

async function openApp(query = '') {
  const AppPage = (await import('../../app/pages/app.vue')).default
  return mountSuspended(AppPage, { route: `/app${query}` })
}

/** Дождаться, пока отработает `onMounted` со своими ожиданиями. */
async function settle() {
  for (let tick = 0; tick < 6; tick += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
  frameWorks = true
  surveysThrows = false
  surveysReply = { ok: true, surveys: SURVEYS }
})

describe('страница приложения', () => {
  it('показывает опубликованные опросы и где выпускать ссылку', async () => {
    const page = await openApp()
    await settle()

    expect(page.text()).toContain('Оценка работы по проекту')
    expect(page.text()).toContain('версия 3')
    // Единственное действие, которое страница обязана объяснить: она сама ссылок не выпускает.
    expect(page.text()).toContain('вкладку «Опросы»')
  })

  it('снаружи портала показывает заглушку, а не интерфейс', async () => {
    frameWorks = false
    const page = await openApp()
    await settle()

    expect(page.text()).toContain('Откройте приложение из Битрикс24')
    // ⚠ Главное утверждение теста: НИЧЕГО рабочего снаружи не показано. Ошибка гейта
    // в пользу «показать» выглядит как исправная страница и потому тихая.
    expect(page.text()).not.toContain('Готовы к выпуску')
    expect(page.text()).not.toContain('Оценка работы по проекту')
  })

  it('на `?preview=1` показывает интерфейс и снаружи портала', async () => {
    // Обход существует ради разработки и скриншотов; здесь он ещё и проверяется,
    // а не просто объявлен в комментарии.
    frameWorks = false
    const page = await openApp('?preview=1')
    await settle()

    expect(page.text()).not.toContain('Откройте приложение из Битрикс24')
  })

  it('различает «смарт-процессов нет» и «анкет нет»', async () => {
    surveysReply = { ok: false, reason: 'not-provisioned' }
    const page = await openApp()
    await settle()

    expect(page.text()).toContain('Приложение ещё настраивается')
    // Пустой список и недоустановленное приложение лечатся по-разному: завести анкету
    // против переустановить от администратора.
    expect(page.text()).not.toContain('Опубликованных анкет пока нет')
  })

  it('незнакомую причину отказа показывает отказом, а не пустым списком', async () => {
    // ⚠ Гвард под находку панели ревью PR #28: раньше любая причина, кроме
    // `not-provisioned`, проваливалась мимо всех веток, и страница сообщала клиенту,
    // что у него нет анкет, — утверждение о его портале, которого мы не проверяли.
    surveysReply = { ok: false, reason: 'degraded' }
    const page = await openApp()
    await settle()

    expect(page.text()).not.toContain('Опубликованных анкет пока нет')
    expect(page.text()).toContain('отказом')
  })

  it('на отказ сети объясняет, что делать', async () => {
    surveysThrows = true
    const page = await openApp()
    await settle()

    expect(page.text()).toContain('Не удалось получить список опросов')
    expect(page.text()).not.toContain('Опубликованных анкет пока нет')
  })

  it('пустой список объясняет словами, а не пустотой', async () => {
    surveysReply = { ok: true, surveys: [] }
    const page = await openApp()
    await settle()

    expect(page.text()).toContain('Опубликованных анкет пока нет')
    expect(page.text()).toContain('Шаблон опроса')
  })
})
