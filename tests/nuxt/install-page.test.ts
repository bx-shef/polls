import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { defineEventHandler, readBody } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Мастер установки в окружении Nuxt.
 *
 * ⚠ Заведён вместе с переводом страницы на общий гейт присутствия в портале (issue #29).
 * До него у `/install` была своя, более ранняя обработка «фрейма нет», и снаружи портала
 * страница советовала «обновить страницу» — совет, который не может сработать в принципе.
 * Тестов у неё при этом не было вовсе, то есть поправить текст было нечем, кроме внимания.
 *
 * Фрейм подменён: настоящий `initializeB24Frame` ждёт ответа от родительского окна,
 * которого в тестовом окружении нет, и висит до таймаута.
 */

/** Ровно то, что возвращает `getAuthData()` — форма списана с реализации SDK, а не с нашего кода. */
const AUTH = {
  access_token: 'фреймовый-токен',
  refresh_token: 'грант-администратора',
  expires: 1789640000,
  expires_in: 3600,
  domain: 'https://shef.bitrix24.ru',
  member_id: 'a223c6b3710f85df22e9377d6c4f7553',
}

let frameWorks = true
let installCalls = 0
let installReply: unknown = { ok: true, provisioned: true }
let finished = 0

vi.mock('@bitrix24/b24jssdk', () => ({
  initializeB24Frame: async () => {
    if (!frameWorks) throw new Error('нет связи с порталом')
    return {
      auth: { getAuthData: () => AUTH },
      installFinish: async () => {
        finished += 1
      },
    }
  },
}))

registerEndpoint('/api/portal/install', defineEventHandler(async (event) => {
  await readBody(event)
  installCalls += 1
  return installReply
}))

async function openInstall(query = '') {
  const InstallPage = (await import('../../app/pages/install.vue')).default
  return mountSuspended(InstallPage, { route: `/install${query}` })
}

/** Дождаться, пока отработает `onMounted` со своими ожиданиями. */
async function settle() {
  for (let tick = 0; tick < 6; tick += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
  frameWorks = true
  installCalls = 0
  finished = 0
  installReply = { ok: true, provisioned: true }
})

describe('мастер установки', () => {
  it('внутри портала доводит установку до конца', async () => {
    const page = await openInstall()
    await settle()

    expect(installCalls).toBe(1)
    expect(finished).toBe(1)
    expect(page.text()).toContain('Приложение установлено')
  })

  it('ГЛАВНОЕ: снаружи портала зовёт открыть из Битрикс24, а не обновить страницу', async () => {
    // ⚠ Прежний текст — «Не удалось связаться с порталом. Обновите страницу» — снаружи
    // портала не может сработать в принципе: страница открыта не оттуда, а не потому,
    // что портал не ответил. Человек обновлял бы её до потери терпения и ушёл бы с мыслью,
    // что приложение сломано.
    frameWorks = false
    const page = await openInstall()
    await settle()

    expect(page.text()).toContain('Откройте приложение из Битрикс24')
    expect(page.text()).not.toContain('Обновите страницу')
  })

  it('снаружи портала НЕ пытается ничего установить', async () => {
    // ⚠ Вторая половина гейта, и без неё первая — украшение. Обмен гранта — необратимая
    // операция: он вращает `refresh_token`. Затевать её, не зная портала, нельзя.
    frameWorks = false
    await openInstall()
    await settle()

    expect(installCalls).toBe(0)
    expect(finished).toBe(0)
  })

  it('снаружи портала не показывает кнопку повтора', async () => {
    // Кнопка, которая выглядит рабочей и не работает, хуже её отсутствия: повторять нечем,
    // фрейма нет.
    frameWorks = false
    const page = await openInstall()
    await settle()

    expect(page.findAll('button')).toHaveLength(0)
  })

  it('на `?preview=1` показывает интерфейс и снаружи портала', async () => {
    // Обход существует ради разработки и скриншотов; здесь он проверяется, а не объявлен.
    frameWorks = false
    const page = await openInstall('?preview=1')
    await settle()

    expect(page.text()).not.toContain('Откройте приложение из Битрикс24')
  })

  it('неполное обустройство показывает словами, а не молчанием', async () => {
    installReply = { ok: true, provisioned: false }
    const page = await openInstall()
    await settle()

    expect(page.text()).toContain('настроено не до конца')
    // ⚠ `installFinish` зовётся и здесь: держать приложение «неустановленным» из-за
    // смарт-процессов значит запереть администратора в мастере навсегда.
    expect(finished).toBe(1)
  })
})
