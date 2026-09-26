import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { defineEventHandler, readBody } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Виджет «Результат опроса» в карточке «Опроса», в окружении Nuxt.
 *
 * Фрейм подменён: настоящий `initializeB24Frame` ждёт ответа от родительского окна,
 * которого в тестовом окружении нет, и висит до таймаута.
 */

const AUTH = {
  access_token: 'фреймовый-токен',
  refresh_token: 'грант',
  expires: 1789640000,
  expires_in: 3600,
  domain: 'https://shef.bitrix24.ru',
  member_id: 'a223c6b3710f85df22e9377d6c4f7553',
}

let frameWorks = true
let placementOptions: unknown = {}
let reply: unknown = null
let sent: Record<string, unknown> | null = null

/** Сколько раз страница попросила портал подогнать размер. */
const resized = vi.fn(async () => {})
/** Запись значения в поле. Её не должно быть НИКОГДА — на этом держится «только чтение». */
const setValue = vi.fn(async () => {})

vi.mock('@bitrix24/b24jssdk', () => ({
  initializeB24Frame: async () => {
    if (!frameWorks) throw new Error('нет связи с порталом')
    return {
      auth: { getAuthData: () => AUTH },
      placement: { options: placementOptions, call: setValue, setValue },
      parent: { resizeWindowAuto: resized },
    }
  },
}))

registerEndpoint('/api/portal/survey-result', defineEventHandler(async (event) => {
  sent = await readBody(event) as Record<string, unknown>
  return reply
}))

const COMPLETED = {
  ok: true,
  completed: true,
  title: 'Бренд',
  version: 3,
  sections: [
    {
      key: 'product',
      title: 'Продукт',
      score: 0,
      answers: [
        { key: 'q1', title: 'Качество', value: '0', scale: 'из 10' },
        { key: 'q2', title: 'Сроки', value: '—', scale: '' },
      ],
    },
    {
      key: 'open',
      title: 'Открытые вопросы',
      score: null,
      answers: [
        { key: 'q3', title: 'Что улучшить?', value: '<b>жирный</b> <img src=x onerror=alert(1)>', scale: '' },
      ],
    },
  ],
}

const SurveyResult = () => import('~/pages/uf/survey-result.vue').then(m => m.default)

/** Дождаться, пока `onMounted` дойдёт до конца: фрейм, запрос, подгонка размера. */
async function settle() {
  for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
  frameWorks = true
  placementOptions = { MODE: 'view', ENTITY_ID: 'CRM_8', ENTITY_VALUE_ID: '15' }
  reply = COMPLETED
  sent = null
  resized.mockClear()
  setValue.mockClear()
})

describe('виджет результата опроса', () => {
  it('снаружи портала объясняет, где он живёт, а не грузится вечно', async () => {
    frameWorks = false

    const page = await mountSuspended(await SurveyResult())
    await settle()

    expect(page.text()).toContain('Откройте карточку в Битрикс24')
    expect(sent).toBeNull()
  })

  it('показывает разделы и ответы словами — ноль нулём, пропуск прочерком', async () => {
    const page = await mountSuspended(await SurveyResult())
    await settle()

    // Пробелы сводим к обычным: между баллом и шкалой стоит неразрывный.
    const text = page.text().replace(/\s+/g, ' ')
    expect(text).toContain('Бренд')
    expect(text).toContain('Продукт')
    expect(text).toContain('Качество')
    expect(text).toContain('0 из 10')
    expect(text).toContain('балл 0')
    expect(text).toContain('—')
  })

  it('отдаёт серверу номер элемента И оба признака карточки', async () => {
    // Чья это карточка, решает сервер: страница только передаёт то, что прислал портал.
    placementOptions = { MODE: 'view', ENTITY_ID: 'CRM_8', ENTITY_VALUE_ID: '15', ENTITY_DATA: { entityTypeId: 1046, entityId: 15 } }

    await mountSuspended(await SurveyResult())
    await settle()

    expect(sent).toMatchObject({ memberId: AUTH.member_id, authId: AUTH.access_token, itemId: 15, entityId: 'CRM_8', entityTypeId: 1046 })
  })

  it('ответ клиента выводит текстом, а не разметкой', async () => {
    // ⚠ Это текст постороннего человека в карточке, которую читает сотрудник. Правило проекта:
    // чужой текст — только интерполяцией, никакого `v-html`.
    const page = await mountSuspended(await SurveyResult())
    await settle()

    expect(page.find('dd b').exists()).toBe(false)
    expect(page.find('img').exists()).toBe(false)
    expect(page.text()).toContain('<b>жирный</b>')
  })

  it('подгоняет высоту поля под содержимое', async () => {
    await mountSuspended(await SurveyResult())
    await settle()

    expect(resized).toHaveBeenCalled()
  })

  it('в режиме правки предупреждает и НЕ пишет значение в поле', async () => {
    // ⚠ Нередактируемость поля держится ровно на том, что `setValue` не зовётся нигде.
    placementOptions = { MODE: 'edit', ENTITY_ID: 'CRM_8', ENTITY_VALUE_ID: '15' }

    const page = await mountSuspended(await SurveyResult())
    await settle()

    expect(page.text()).toContain('править результат вручную нельзя')
    expect(setValue).not.toHaveBeenCalled()
  })

  it('пока клиент не ответил, говорит об этом словами', async () => {
    reply = { ok: true, completed: false }

    const page = await mountSuspended(await SurveyResult())
    await settle()

    expect(page.text()).toContain('Клиент ещё не прошёл опрос')
  })

  it('в новой карточке сервер не спрашивает', async () => {
    placementOptions = { MODE: 'edit', ENTITY_ID: 'CRM_8', ENTITY_VALUE_ID: 0 }

    const page = await mountSuspended(await SurveyResult())
    await settle()

    expect(sent).toBeNull()
    expect(page.text()).toContain('Результат появится здесь')
  })

  it('поле, заведённое не на «Опросе», объясняет себя', async () => {
    reply = { ok: false, reason: 'foreign-card' }

    const page = await mountSuspended(await SurveyResult())
    await settle()

    expect(page.text()).toContain('работает только в карточке «Опроса»')
  })
})
