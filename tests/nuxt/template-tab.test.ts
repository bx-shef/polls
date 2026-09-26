import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { defineEventHandler, readBody } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Вкладка конструктора в окружении Nuxt.
 *
 * ⚠ Первый гвард — про ПОРЯДОК веток, и он под уже случившийся дефект. У `/install` ветка
 * «мы не внутри портала» стояла НИЖЕ скелета, и снаружи страница показывала бесконечную
 * загрузку: `stage` оставался `starting`, до объяснения дело не доходило никогда. Текст
 * при этом был написан правильный — не работал порядок. Вкладка конструктора попадает
 * наружу тем же способом (адрес знает только портал), значит и ловушка та же.
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
let placementOptions: unknown = { ID: '42' }
let reply: unknown

vi.mock('@bitrix24/b24jssdk', () => ({
  initializeB24Frame: async () => {
    if (!frameWorks) throw new Error('нет связи с порталом')
    return {
      auth: { getAuthData: () => AUTH },
      placement: { options: placementOptions },
    }
  },
}))

registerEndpoint('/api/portal/template', defineEventHandler(async (event) => {
  await readBody(event)
  return reply
}))

const DRAFT = {
  ok: true,
  problems: [],
  template: { id: 42, code: 'brand', version: 0, state: 'draft', schema: null },
}

const PUBLISHED = {
  ok: true,
  problems: [
    { level: 'error', where: 'Раздел «Продукт»', message: 'Шкала не покрыта на отрезке 6–10.' },
    { level: 'warning', where: 'Анкета', message: 'Диапазон не сработает никогда.' },
  ],
  template: {
    id: 42,
    code: 'brand',
    version: 3,
    state: 'published',
    schema: {
      code: 'brand',
      title: 'Бренд-платформа',
      sections: [{
        key: 'product',
        title: 'Продукт',
        scored: true,
        questions: [
          { key: 'P1', title: 'Насколько удобно?', type: 'scale', weight: 1, scored: true, scale: { min: 0, max: 10 } },
          { key: 'T1', title: 'Что улучшить?', type: 'text', weight: 0, scored: false },
        ],
        bands: [{ from: 0, to: 6, text: 'Плохо' }, { from: 7, to: 10, text: 'Хорошо' }],
      }],
    },
  },
}

async function open() {
  const page = await import('../../app/pages/portal/template-tab.vue')
  const mounted = await mountSuspended(page.default)
  await new Promise(resolve => setTimeout(resolve, 0))
  return mounted.text()
}

beforeEach(() => {
  frameWorks = true
  placementOptions = { ID: '42' }
  reply = PUBLISHED
})

describe('вкладка конструктора', () => {
  it('ГЛАВНОЕ: снаружи портала объясняет, а не грузится вечно', async () => {
    // ⚠ Дефект этого класса уже случался на `/install`: ветка «фрейма нет» стояла ниже
    // скелета и не отрисовывалась никогда. Проверяем не текст, а то, что до него дошли.
    frameWorks = false

    const text = await open()

    expect(text).toContain('Откройте вкладку из Битрикс24')
  })

  it('черновик с пустой схемой ОТКРЫВАЕТСЯ', async () => {
    // ⚠ Ровно то, ради чего у конструктора свой читатель элемента: выбор анкеты такой
    // элемент молча пропускает, а конструктор обязан его открыть — иначе собрать анкету
    // с нуля будет негде, и человек останется наедине с текстовым полем для JSON.
    reply = DRAFT

    const text = await open()

    expect(text).toContain('Черновик')
    expect(text).toContain('Схема анкеты пуста')
  })

  it('опубликованная версия предупреждает о неизменяемости ДО правок', async () => {
    // ⚠ Инвариант проекта: опубликованная версия неизменяема, правка порождает новую.
    // Сказать об этом в момент отказа сохранить — значит дать человеку потратить двадцать
    // минут впустую.
    const text = await open()

    expect(text).toContain('Опубликована')
    expect(text).toContain('Версия 3')
    expect(text).toContain('уже опубликована')
  })

  it('показывает разделы, вопросы и диапазоны словами', async () => {
    // Это и есть польза вкладки на сегодня: в карточке вместо неё простыня JSON в одну строку.
    const text = await open()

    expect(text).toContain('Бренд-платформа')
    expect(text).toContain('Насколько удобно?')
    expect(text).toContain('Балльный')
    expect(text).toContain('шкала 0–10')
    expect(text).toContain('не идёт в оценку')
    expect(text).toContain('Плохо')
  })

  it('показывает, что мешает опубликовать, и отдельно — что стоит знать', async () => {
    // ⚠ Претензии считает СЕРВЕР: `app/` не имеет права импортировать серверные модули,
    // а проверка живёт в домене, рядом с расчётом баллов. Вкладка их только показывает —
    // и обязана разводить запрещающие и необязательные, иначе человек либо испугается
    // замечания, либо не заметит запрета.
    const text = await open()

    expect(text).toContain('Пока нельзя опубликовать')
    expect(text).toContain('Шкала не покрыта на отрезке 6–10')
    expect(text).toContain('Стоит знать')
  })

  it('переживает ответ без списка претензий', async () => {
    // ⚠ Стык версий: открытая вкладка живёт в браузере дольше перезапуска контейнера,
    // поэтому старый ответ у новой страницы — штатный случай, а не «такого не бывает».
    // Без защиты страница падала целиком, и снаружи это выглядело как поломка конструктора.
    reply = { ok: true, template: PUBLISHED.template }

    const text = await open()

    expect(text).toContain('Бренд-платформа')
    expect(text).not.toContain('Пока нельзя опубликовать')
  })

  it('без идентификатора элемента говорит, откуда открывать', async () => {
    // Вкладку можно открыть по прямому адресу; тогда анкеты нет, и «обновите страницу»
    // было бы советом, который не может сработать.
    placementOptions = {}
    reply = { ok: false, reason: 'no-item' }

    const text = await open()

    expect(text).toContain('Анкета не определена')
  })

  it('ненастроенный портал отличается от отсутствующей анкеты', async () => {
    // Первое лечит администратор переустановкой, второе — открыть вкладку из карточки.
    // Один текст на оба случая отправлял бы половину людей чинить не то.
    reply = { ok: false, reason: 'not-provisioned' }

    const text = await open()

    expect(text).toContain('Приложение ещё настраивается')
  })
})
