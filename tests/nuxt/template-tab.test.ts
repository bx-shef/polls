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

/** Куда вкладка попросила портал открыть слайдер. */
let sliderPath = ''

vi.mock('@bitrix24/b24jssdk', () => ({
  initializeB24Frame: async () => {
    if (!frameWorks) throw new Error('нет связи с порталом')
    return {
      auth: { getAuthData: () => AUTH },
      placement: { options: placementOptions },
      slider: {
        // Форма списана с SDK: `getUrl` знает адрес портала, `openPath` принимает URL.
        getUrl: (path: string) => new URL(path, 'https://shef.bitrix24.ru'),
        openPath: async (url: URL) => {
          sliderPath = url.pathname
        },
      },
    }
  },
}))

registerEndpoint('/api/portal/template', defineEventHandler(async (event) => {
  await readBody(event)
  return reply
}))

/** Что вкладка отправила на сохранение — проверяем именно это, а не только вид кнопок. */
let sent: Record<string, unknown> | null = null
let saveReply: unknown = null

registerEndpoint('/api/portal/template-save', defineEventHandler(async (event) => {
  sent = await readBody(event) as Record<string, unknown>
  return saveReply ?? { ok: true, problems: [], template: { ...PUBLISHED.template, state: 'draft' } }
}))

/** Что ушло на публикацию и что ответил сервер. */
let released: Record<string, unknown> | null = null
let releaseReply: unknown = null

registerEndpoint('/api/portal/template-publish', defineEventHandler(async (event) => {
  released = await readBody(event) as Record<string, unknown>
  return releaseReply ?? { ok: true, action: 'publish', version: 4 }
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
  sent = null
  saveReply = null
  released = null
  releaseReply = null
  sliderPath = ''
})

/** Открыть вкладку и вернуть смонтированное — чтобы можно было нажимать кнопки. */
async function mount() {
  const page = await import('../../app/pages/portal/template-tab.vue')
  const mounted = await mountSuspended(page.default)
  await new Promise(resolve => setTimeout(resolve, 0))
  return mounted
}

/** Найти кнопку по подписи. Ищем по тексту: его видит человек, а не по классу. */
function button(mounted: Awaited<ReturnType<typeof mount>>, label: string) {
  return mounted.findAll('button').find(b => b.text().includes(label))
}

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

describe('правка черновика', () => {
  it('ГЛАВНОЕ: у опубликованной версии кнопки «Править» НЕТ ВОВСЕ', async () => {
    // ⚠ Не «есть, но отказывает». Предлагать действие, которое заведомо не сработает, —
    // способ потратить чужое время: человек нажмёт, наберёт правки и узнает о запрете
    // в конце. Настоящий запрет при этом на сервере (вкладка могла быть открыта час назад),
    // здесь только честный вид.
    const mounted = await mount()

    expect(button(mounted, 'Править')).toBeUndefined()
    expect(mounted.text()).toContain('уже опубликована')
  })

  it('черновик правится, и поля появляются', async () => {
    reply = { ...DRAFT, template: { ...PUBLISHED.template, state: 'draft', version: 0 } }
    const mounted = await mount()

    await button(mounted, 'Править')!.trigger('click')

    expect(mounted.findAll('input').length).toBeGreaterThan(0)
    expect(button(mounted, 'Сохранить')).toBeDefined()
    expect(button(mounted, 'Добавить раздел')).toBeDefined()
  })

  it('ГЛАВНОЕ: новый вопрос уезжает БЕЗ ключа', async () => {
    // ⚠ Ключ выдаёт сервер: генератор живёт в домене, а `app/` в серверные модули не ходит
    // по правилу проекта. Своя копия генератора в браузере была бы вторым словарём на одну
    // вещь. А ещё ключи обязаны не переиспользоваться после удаления — и это свойство
    // держится одним генератором, а не двумя похожими.
    reply = { ...DRAFT, template: { ...PUBLISHED.template, state: 'draft', version: 0 } }
    const mounted = await mount()

    await button(mounted, 'Править')!.trigger('click')
    await button(mounted, 'Добавить вопрос')!.trigger('click')
    await button(mounted, 'Сохранить')!.trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    const schema = sent!.schema as { sections: { questions: { key: string }[] }[] }
    expect(schema.sections[0]!.questions.some(q => q.key === '')).toBe(true)
  })

  it('ГЛАВНОЕ: отказ сохранения НЕ вытирает форму с правками', async () => {
    // ⚠ Нашёл `/code-review`. Отказ писался в общий `failure`, а тот стоит в ветке выше
    // редактора и подменяет его собой целиком: правки исчезали с экрана, совет «сократите
    // тексты» выполнить было нечем, и оставалось перезагрузить страницу, потеряв работу.
    // Проверяем не текст отказа — его проверял и прежний тест, — а то, что форма ЖИВА.
    reply = { ...DRAFT, template: { ...PUBLISHED.template, state: 'draft', version: 0 } }
    saveReply = { ok: false, reason: 'too-big' }
    const mounted = await mount()

    await button(mounted, 'Править')!.trigger('click')
    const before = mounted.findAll('input').length
    await button(mounted, 'Сохранить')!.trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(mounted.text()).toContain('Сократите тексты')
    expect(mounted.findAll('input')).toHaveLength(before)
    expect(button(mounted, 'Сохранить')).toBeDefined()
  })

  it('отказ «уже опубликовали» объясняется словами', async () => {
    // Версию могли опубликовать, пока вкладка была открыта. «Попробуйте ещё раз» здесь —
    // обман: сколько ни пробуй, опубликованная версия не примет правок.
    reply = { ...DRAFT, template: { ...PUBLISHED.template, state: 'draft', version: 0 } }
    saveReply = { ok: false, reason: 'published' }
    const mounted = await mount()

    await button(mounted, 'Править')!.trigger('click')
    await button(mounted, 'Сохранить')!.trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(mounted.text()).toContain('создайте новую версию')
  })

  it('после сохранения правим то, что СОХРАНИЛОСЬ', async () => {
    // ⚠ Копия выбрасывается намеренно: сервер раздал ключи новым вопросам. Продолжив править
    // прежнюю копию, мы отправили бы эти ключи обратно пустыми — и при следующем сохранении
    // им выдали бы новые, оторвав уже собранные ответы от их вопросов.
    reply = { ...DRAFT, template: { ...PUBLISHED.template, state: 'draft', version: 0 } }
    const mounted = await mount()

    await button(mounted, 'Править')!.trigger('click')
    await button(mounted, 'Сохранить')!.trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(button(mounted, 'Сохранить')).toBeUndefined()
    expect(mounted.text()).toContain('Сохранено')
  })
})

describe('публикация и новая версия', () => {
  it('ГЛАВНОЕ: у опубликованной версии ровно одно действие — новая версия', async () => {
    // ⚠ Инвариант: опубликованная неизменяема, по ней уже собрана статистика, а ссылки
    // у людей ведут именно на неё. Новая версия — единственная разрешённая форма её правки,
    // и кнопки «Опубликовать» рядом быть не должно: публиковать уже опубликованное нечего.
    const mounted = await mount()

    expect(button(mounted, 'Создать новую версию')).toBeDefined()
    expect(button(mounted, 'Опубликовать')).toBeUndefined()
    expect(button(mounted, 'Править')).toBeUndefined()
  })

  it('черновик с ошибками опубликовать НЕЛЬЗЯ', async () => {
    // ⚠ Сохранить черновик с дырой в диапазонах можно — иначе его негде доделывать. А вот
    // опубликовать нельзя: опубликованную версию уже не починить, только выпустить новую,
    // и ссылки, ушедшие людям, останутся на сломанной.
    reply = {
      ...PUBLISHED,
      template: { ...PUBLISHED.template, state: 'draft', version: 0 },
    }
    const mounted = await mount()

    expect(button(mounted, 'Опубликовать')!.attributes('disabled')).toBeDefined()
    expect(mounted.text()).toContain('Сначала исправьте то, что мешает')
  })

  it('здоровый черновик публикуется и перечитывается', async () => {
    reply = { ...DRAFT, template: { ...PUBLISHED.template, state: 'draft', version: 0 } }
    const mounted = await mount()

    await button(mounted, 'Опубликовать')!.trigger('click')
    // ⚠ Двух шагов мало: публикация, потом ПЕРЕЧИТКА состояния с портала, и только затем
    // сообщение. Перечитка вынесена из `try` публикации намеренно — её отказ не должен
    // выглядеть как несостоявшаяся публикация.
    for (let tick = 0; tick < 5; tick += 1) await new Promise(resolve => setTimeout(resolve, 0))

    expect(released!.action).toBe('publish')
    expect(mounted.text()).toContain('опубликована как версия 4')
  })

  it('отказ публикации объясняется и не ломает экран', async () => {
    reply = { ...DRAFT, template: { ...PUBLISHED.template, state: 'draft', version: 0 } }
    releaseReply = { ok: false, reason: 'invalid' }
    const mounted = await mount()

    await button(mounted, 'Опубликовать')!.trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(mounted.text()).toContain('пока в ней есть то, что мешает')
    expect(button(mounted, 'Опубликовать')).toBeDefined()
  })
})

describe('карточка новой версии', () => {
  it('ГЛАВНОЕ: адрес собирается с типом объекта, который прислал сервер', async () => {
    // ⚠ Вкладка тип объекта НЕ ЗНАЕТ: портал кладёт во фрейм только идентификатор элемента,
    // а тип отдельным ключом не приходит вовсе. Прежняя редакция читала его из строки запроса,
    // которой у обработчика нет, и всегда получала ноль — адрес выходил `/crm/type//details/N/`,
    // слайдер открывал сломанную страницу, и запасной текст не срабатывал: `openPath`
    // на это не ругается. Нашёл `/code-review`.
    releaseReply = { ok: true, action: 'new-version', itemId: 77, entityTypeId: 1038 }
    const mounted = await mount()

    await button(mounted, 'Создать новую версию')!.trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(sliderPath).toBe('/crm/type/1038/details/77/')
  })

  it('без типа объекта называет номер карточки, а не молчит', async () => {
    // Слайдер не открыть — значит человек должен хотя бы знать, что искать в списке.
    releaseReply = { ok: true, action: 'new-version', itemId: 77 }
    const mounted = await mount()

    await button(mounted, 'Создать новую версию')!.trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(sliderPath).toBe('')
    expect(mounted.text()).toContain('№77')
  })

  it('черновик уже был — открываем его, а не заводим второй', async () => {
    // ⚠ Инвариант: перед созданием — поиск существующего. Без него каждое нажатие заводило бы
    // ещё один черновик той же анкеты, и каждый публиковался бы отдельной версией.
    releaseReply = { ok: true, action: 'new-version', itemId: 55, entityTypeId: 1038, reused: true }
    const mounted = await mount()

    await button(mounted, 'Создать новую версию')!.trigger('click')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(mounted.text()).toContain('уже был заведён раньше')
    expect(sliderPath).toBe('/crm/type/1038/details/55/')
  })
})
