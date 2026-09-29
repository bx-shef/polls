import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { defineEventHandler, readBody } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Поле «Анкета» в карточке «Шаблона опроса», в окружении Nuxt (#84, п. 18).
 *
 * Фрейм подменён, как у виджета результата (`survey-result.test.ts`): настоящий `initializeB24Frame`
 * ждёт ответа от родительского окна, которого в тестовом окружении нет.
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

const resized = vi.fn(async (_command: string, _params: Record<string, unknown>) => {})
/** Запись значения в поле. Её не должно быть НИКОГДА — на этом держится «только чтение». */
const setValue = vi.fn(async () => {})

vi.mock('@bitrix24/b24jssdk', () => ({
  MessageCommands: { resizeWindow: 'resizeWindow' },
  initializeB24Frame: async () => {
    if (!frameWorks) throw new Error('нет связи с порталом')
    return {
      auth: { getAuthData: () => AUTH },
      placement: { options: placementOptions, call: setValue, setValue },
      parent: { message: { send: resized } },
    }
  },
}))

registerEndpoint('/api/portal/survey-form', defineEventHandler(async (event) => {
  sent = await readBody(event) as Record<string, unknown>
  return reply
}))

const PUBLISHED = {
  ok: true,
  form: {
    code: 'brand',
    version: 3,
    state: 'published',
    title: 'Бренд',
    sections: [
      {
        key: 'product',
        title: 'Продукт',
        scored: true,
        questions: [
          { key: 'q1', title: 'Качество', type: 'scale', scored: true, scale: { min: 0, max: 10 } },
          { key: 'q2', title: 'Когда перезвонить?', type: 'date', scored: false, scale: null },
        ],
        bands: [{ from: 0, to: 6, text: 'Нам жаль' }, { from: 7, to: 10, text: 'Спасибо!' }],
      },
      {
        key: 'open',
        title: 'Открытые вопросы',
        scored: false,
        questions: [{ key: 'q3', title: '<b>жирный</b> <img src=x onerror=alert(1)>', type: 'text', scored: false, scale: null }],
        bands: [],
      },
    ],
  },
}

const SurveyForm = () => import('~/pages/uf/survey-form.vue').then(m => m.default)

/** Дождаться, пока `onMounted` дойдёт до конца: фрейм, запрос, подгонка размера. */
async function settle() {
  for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
  frameWorks = true
  placementOptions = { MODE: 'view', ENTITY_ID: 'CRM_7', ENTITY_VALUE_ID: '26' }
  reply = PUBLISHED
  sent = null
  resized.mockClear()
  setValue.mockClear()
})

describe('поле «Анкета»', () => {
  it('снаружи портала объясняет, где оно живёт, а не грузится вечно', async () => {
    frameWorks = false

    const page = await mountSuspended(await SurveyForm())
    await settle()

    expect(page.text()).toContain('Откройте карточку в Битрикс24')
    expect(sent).toBeNull()
  })

  it('ГЛАВНОЕ: показывает анкету словами — разделы, вопросы, шкалы и диапазоны', async () => {
    const page = await mountSuspended(await SurveyForm())
    await settle()

    const text = page.text().replace(/\s+/g, ' ')
    expect(text).toContain('Бренд · версия 3')
    expect(text).toContain('Продукт')
    expect(text).toContain('С баллом')
    // Формулировку от типа отделяет отступ вёрстки, а не пробел: проверяем строку вопроса целиком.
    const questions = page.findAll('li').map(li => li.text().replace(/\s+/g, ' '))
    expect(questions).toContain('КачествоБалльный, шкала 0–10')
    // У даты — те же слова, что в конструкторе: как её увидит клиент.
    expect(questions).toContain('Когда перезвонить?Дата, клиент выберет её в календаре, не идёт в оценку')
    expect(text).toContain('0–6: Нам жаль')
    expect(text).toContain('Без балла')
  })

  it('формулировку сотрудника выводит текстом, а не разметкой', async () => {
    // ⚠ Текст, введённый на портале, — только интерполяцией: правило проекта.
    const page = await mountSuspended(await SurveyForm())
    await settle()

    expect(page.find('li b').exists()).toBe(false)
    expect(page.find('img').exists()).toBe(false)
    expect(page.text()).toContain('<b>жирный</b>')
  })

  it('черновик без версии так и называет, а пустой — ведёт в конструктор', async () => {
    reply = { ok: true, form: { code: '', version: 0, state: 'draft', title: 'Новая анкета', sections: [] } }

    const page = await mountSuspended(await SurveyForm())
    await settle()

    expect(page.text()).toContain('черновик, версии ещё нет')
    expect(page.text()).toContain('Анкета пока пустая')
    expect(page.text()).toContain('«[sh] Конструктор»')
  })

  it('отдаёт серверу номер элемента и оба признака карточки', async () => {
    placementOptions = { MODE: 'view', ENTITY_ID: 'CRM_7', ENTITY_VALUE_ID: '26', ENTITY_DATA: { entityTypeId: 1044, entityId: 26 } }

    await mountSuspended(await SurveyForm())
    await settle()

    expect(sent).toMatchObject({ memberId: AUTH.member_id, authId: AUTH.access_token, itemId: 26, entityId: 'CRM_7', entityTypeId: 1044 })
  })

  it('в режиме правки ведёт в конструктор и НЕ пишет значение в поле', async () => {
    placementOptions = { MODE: 'edit', ENTITY_ID: 'CRM_7', ENTITY_VALUE_ID: '26' }

    const page = await mountSuspended(await SurveyForm())
    await settle()

    expect(page.text()).toContain('Править её — во вкладке «[sh] Конструктор»')
    expect(setValue).not.toHaveBeenCalled()
  })

  it('подгоняет высоту поля, оставляя ширину резиновой', async () => {
    await mountSuspended(await SurveyForm())
    await settle()

    const [command, params] = resized.mock.calls.at(-1)!
    expect(command).toBe('resizeWindow')
    expect(params.width).toBe('100%')
    expect(typeof params.height).toBe('number')
  })

  it('поле, заведённое не на «Шаблоне», объясняет себя', async () => {
    reply = { ok: false, reason: 'foreign-card' }

    const page = await mountSuspended(await SurveyForm())
    await settle()

    expect(page.text()).toContain('работает только в карточке «[sh] Шаблон опроса»')
  })

  it('без признаков карточки не советует удалить поле', async () => {
    reply = { ok: false, reason: 'no-owner' }

    const page = await mountSuspended(await SurveyForm())
    await settle()

    expect(page.text()).toContain('Обновите карточку')
    expect(page.text()).not.toContain('удалить')
  })

  it('в новой карточке сервер не спрашивает', async () => {
    placementOptions = { MODE: 'edit', ENTITY_ID: 'CRM_7', ENTITY_VALUE_ID: 0 }

    const page = await mountSuspended(await SurveyForm())
    await settle()

    expect(sent).toBeNull()
    expect(page.text()).toContain('Анкета появится здесь')
  })
})
