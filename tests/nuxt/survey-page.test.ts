import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { defineEventHandler, setResponseStatus } from 'h3'
import { describe, expect, it, vi } from 'vitest'
import SurveyPage from '../../app/pages/s/[token].vue'

/**
 * Публичная страница анкеты в окружении Nuxt. Здесь живут два инварианта проекта, которые
 * без смонтированного компонента не проверить никак: «нет ответа — это `null`, а не ноль»
 * и «текст с портала рендерится своим экранированием, а не разметкой».
 *
 * Плюс гвард под дефект, найденный панелью ревью PR #15: `useFetch` без `ignoreResponseError`
 * отбрасывает тело не-2xx ответа, а именно телом мы объясняем человеку, что происходит.
 * Та же ловушка уже ловилась на странице-заглушке каркаса — и повторилась здесь.
 */

/**
 * ⚠ Пояс подменяется, и это часть проверки, а не обстановка. Контейнер живёт в UTC,
 * и без подмены гвард на «дату показываем в поясе респондента» не мог бы упасть в принципе:
 * возврат к `getUTC*` дал бы ту же строку. Минск выбран потому, что там портал заказчика, —
 * то есть смещение настоящее, а не выдуманное.
 *
 * Присваивание работает и после импортов: Node на запись `process.env.TZ` дёргает V8,
 * и следующий же `new Date()` считает по новому поясу. Дата в странице считается при
 * монтировании, то есть заведомо позже.
 */
process.env.TZ = 'Europe/Minsk'

/**
 * У каждого сценария свой токен, и это не украшательство: `useFetch` кэширует ответ
 * по ключу запроса, и общий токен отдал бы всем тестам результат первого.
 */
const TOKENS = {
  survey: 'a'.repeat(43),
  expired: 'b'.repeat(43),
  limited: 'c'.repeat(43),
  broken: 'd'.repeat(43),
  headed: 'e'.repeat(43),
  partial: 'f'.repeat(43),
  verdict: 'g'.repeat(43),
  plain: 'h'.repeat(43),
}

/** Анкета с одним балльным и одним текстовым вопросом; заголовок — с попыткой инъекции. */
const SURVEY = {
  ok: true,
  survey: {
    title: 'Как вам работалось',
    sections: [{
      key: 'product',
      title: 'Продукт',
      questions: [
        { key: 'Q1', title: 'Оцените <script>alert(1)</script> результат', type: 'scale', scale: { min: 0, max: 3 } },
        { key: 'T1', title: 'Что понравилось', type: 'text' },
      ],
    }],
  },
}

/** Подменить эндпоинт для одного сценария. Код ответа настоящий, а не 200 с телом. */
function serve(token: string, body: unknown, status = 200) {
  registerEndpoint(`/api/s/${token}`, defineEventHandler((event) => {
    if (status !== 200) setResponseStatus(event, status)
    return body
  }))
}

/**
 * Показ и отправка живут на ОДНОМ адресе, и различает их метод. Подделка обязана
 * различать так же: иначе тест отправки читал бы ответ показа и проходил бы ни на чём.
 */
function serveBoth(token: string, get: unknown, post: unknown) {
  registerEndpoint(`/api/s/${token}`, defineEventHandler(event => event.method === 'POST' ? post : get))
}

/** Та же анкета, но с шапкой: компания, проект, дата, кто спрашивает и кого. */
const HEADER = {
  company: 'Ромашка Дистрибуция',
  project: 'Рекламная кампания, осень',
  respondent: 'Игорь Петров',
  manager: 'Мария Ковалёва',
  issuedAt: '2026-09-12T14:20:00.000Z',
}

serve(TOKENS.survey, SURVEY)
serve(TOKENS.headed, { ...SURVEY, header: HEADER })
serve(TOKENS.partial, { ...SURVEY, header: { ...HEADER, company: '', respondent: '', manager: '' } })
serve(TOKENS.expired, { ok: false, reason: 'expired', title: 'Срок ссылки истёк', detail: 'Попросите новую.' })
serve(TOKENS.limited, { ok: false, reason: 'rate-limited', title: 'Слишком много попыток', detail: 'Подождите минуту.' }, 429)
serve(TOKENS.broken, { statusCode: 503, statusMessage: 'Not configured' }, 503)
serveBoth(TOKENS.verdict, SURVEY, {
  ok: true,
  verdicts: [{ section: 'Продукт', text: 'Продолжаем двигаться вперед!' }],
})
serveBoth(TOKENS.plain, SURVEY, { ok: true, verdicts: [] })

async function openPage(token: string) {
  return mountSuspended(SurveyPage, { route: `/s/${token}` })
}

describe('анкета', () => {
  it('показывает вопросы и ползунок со шкалой вопроса', async () => {
    const page = await openPage(TOKENS.survey)

    expect(page.text()).toContain('Как вам работалось')
    expect(page.text()).toContain('Что понравилось')

    // Границы берутся из самого вопроса (0–3), а не из умолчания набора (0–100):
    // иначе респондент тянул бы ручку по шкале, которой у вопроса нет.
    const knob = page.find('[role="slider"]')
    expect(knob.exists()).toBe(true)
    expect(knob.attributes('aria-valuemin')).toBe('0')
    expect(knob.attributes('aria-valuemax')).toBe('3')
  })

  it('НЕ выставляет балл за респондента, хотя ручка ползунка где-то стоит', async () => {
    // ⚠ ГЛАВНЫЙ ГВАРД ЭТОГО ВИДЖЕТА, и он же причина, по которой ползунок вообще можно было
    // взять. Инвариант проекта: балльный вопрос не имеет предустановленного значения.
    // У ползунка значение есть ВСЕГДА — и старое решение заказчика на этом погорело:
    // нетронутый стоял на нуле и уезжал на сервер честным нулём (README присланного архива
    // называет это первым же наблюдением по дизайну). Здесь положение ручки и ответ —
    // разные вещи: подпись говорит «—», а не число, и разметка помечена как нетронутая.
    const page = await openPage(TOKENS.survey)

    expect(page.find('.scale').classes()).toContain('untouched')
    expect(page.find('output.value').text()).toBe('—')
  })

  it('первое касание записывает настоящее число — в том числе ноль', async () => {
    // Ноль — законная оценка, и отличать её от «не отвечал» обязана не догадка, а состояние.
    const page = await openPage(TOKENS.survey)

    await page.findComponent({ name: 'B24Range' }).vm.$emit('update:modelValue', 0)
    await page.vm.$nextTick()

    expect(page.find('output.value').text()).toBe('0')
    expect(page.find('.scale').classes()).not.toContain('untouched')
  })

  it('сброс ответа возвращает вопрос в «не отвечал»', async () => {
    // ⚠ ГВАРД ВОССТАНОВЛЕН ПОСЛЕ ПОТЕРИ. На кнопках это делалось повторным нажатием
    // по выбранному делению, и гвард на это был. Перейдя на ползунок, я унёс и возможность,
    // и гвард вместе с ней — то есть промах пальцем НАВСЕГДА превращался бы в оценку,
    // которой человек не ставил. Issue #16 называл это требование прямо: «сохранить снятие
    // выбора повторным нажатием», — а закрыть issue, потеряв единственное, что от него
    // осталось живым, значит спрятать регрессию.
    const page = await openPage(TOKENS.survey)

    await page.findComponent({ name: 'B24Range' }).vm.$emit('update:modelValue', 7)
    await page.vm.$nextTick()
    expect(page.find('output.value').text()).toBe('7')

    await page.find('button.clear').trigger('click')
    await page.vm.$nextTick()

    expect(page.find('output.value').text()).toBe('—')
    expect(page.find('.scale').classes()).toContain('untouched')
  })

  it('у нетронутого вопроса кнопки сброса НЕТ', async () => {
    // Сбрасывать нечего, а кнопка, которая ничего не делает, — это лишняя остановка
    // при обходе с клавиатуры: на анкете в тринадцать вопросов их было бы тринадцать.
    const page = await openPage(TOKENS.survey)

    expect(page.find('button.clear').exists()).toBe(false)
  })

  it('кнопка сброса не тащит текст вопроса в атрибуты', async () => {
    // ⚠ Тот же запрет, что у подписи ползунка: формулировку пишет сотрудник портала,
    // а читает посторонний человек. Имя кнопке даёт НАШ текст, связь с вопросом —
    // идентификатор, собранный из номеров секции и вопроса.
    const page = await openPage(TOKENS.survey)
    await page.findComponent({ name: 'B24Range' }).vm.$emit('update:modelValue', 7)
    await page.vm.$nextTick()

    const clear = page.find('button.clear')
    expect(clear.attributes('aria-describedby')).toBe('q0-0')
    expect(clear.attributes('aria-label')).toBeUndefined()
    expect(clear.text()).toContain('Сбросить ответ')
  })

  it('рендерит текст с портала текстом, а не разметкой', async () => {
    // Формулировку пишет сотрудник портала, читает посторонний респондент — прямой путь
    // для XSS. Закрыт тем, что разметки здесь не бывает вовсе: только `{{ }}`.
    const page = await openPage(TOKENS.survey)

    expect(page.html()).not.toContain('<script>alert(1)</script>')
    expect(page.text()).toContain('<script>alert(1)</script>')
  })
})

describe('шапка анкеты', () => {
  it('показывает компанию, тип опроса, проект, дату, менеджера и респондента', async () => {
    const page = await openPage(TOKENS.headed)
    const text = page.text()

    expect(text).toContain('Ромашка Дистрибуция')
    // Название анкеты в шапке — это «тип опроса» из макета, верхней строкой первого блока.
    expect(text).toContain('Как вам работалось')
    expect(text).toContain('Рекламная кампания, осень')
    // Выпущено в 14:20 UTC, показано в 17:20 по Минску — см. гвард ниже.
    expect(text).toContain('12.09.2026 17:20')
    expect(text).toContain('Мария Ковалёва')
    expect(text).toContain('Игорь Петров')
  })

  it('дату показывает в поясе РЕСПОНДЕНТА, а не в UTC', async () => {
    // ⚠ Решение владельца 23.09. Первая редакция считала по UTC, и у портала в UTC+3
    // в шапке стояло время на три часа раньше настоящего — ошибка, которую никто
    // не заметил бы, пока кто-нибудь не сверил её с письмом.
    const page = await openPage(TOKENS.headed)

    expect(page.find('.masthead').text()).toContain('12.09.2026 17:20')
    expect(page.find('.masthead').text()).not.toContain('14:20')
  })

  it('формат даты свой, а не локаль окружения', async () => {
    // Пояс здесь про правду, формат — про макет: `ДД.ММ.ГГГГ ЧЧ:ММ` обязан выглядеть
    // одинаково у респондента с любой локалью, иначе у половины людей шапка поедет
    // в `9/12/2026, 5:20 PM`.
    const page = await openPage(TOKENS.headed)

    expect(page.text()).not.toContain('2026-09-12T14:20')
    expect(page.find('.masthead').text()).toMatch(/\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/)
  })

  it('незаполненные строки шапки просто не рисует', async () => {
    // ⚠ У сделки может не быть ни компании, ни контакта — команда пакета приезжает
    // `NOT_FOUND`, и в снимке остаётся пустая строка. Рисовать пустой заголовок в 60 px
    // значит показать человеку дыру во весь экран.
    const page = await openPage(TOKENS.partial)

    expect(page.find('.company').exists()).toBe(false)
    // Проект на месте — значит шапка не схлопнулась целиком.
    expect(page.text()).toContain('Рекламная кампания, осень')
  })

  it('без шапки показывает название анкеты заголовком, как раньше', async () => {
    // Ссылки, выпущенные до появления снимка, обязаны открываться. Их в базе уже есть.
    const page = await openPage(TOKENS.survey)

    expect(page.find('.masthead').exists()).toBe(false)
    expect(page.find('h1').text()).toBe('Как вам работалось')
  })
})

describe('когда анкету показать нельзя', () => {
  it('объясняет причину отказа словами', async () => {
    const page = await openPage(TOKENS.expired)

    expect(page.text()).toContain('Срок ссылки истёк')
    expect(page.text()).toContain('Попросите новую.')
  })

  it('показывает текст отказа, пришедшего с кодом 429', async () => {
    // Гвард под дефект PR #15: без `ignoreResponseError` тело не-2xx отбрасывается,
    // и человек вместо «подождите минуту» видел общую карточку «анкета недоступна».
    const page = await openPage(TOKENS.limited)

    expect(page.text()).toContain('Слишком много попыток')
    expect(page.text()).toContain('Подождите минуту.')
  })

  it('на чужую ошибку показывает общую карточку, а не пустоту', async () => {
    // Стандартная ошибка Nitro: ни `ok`, ни `title`. Отрисовать её как отказ значило бы
    // показать человеку `undefined`.
    const page = await openPage(TOKENS.broken)

    expect(page.text()).toContain('Анкета недоступна')
    expect(page.text()).not.toContain('undefined')
  })
})

describe('вердикт после отправки', () => {
  /**
   * Нажать «Отправить» и дождаться перерисовки.
   *
   * ⚠ Ждём УСЛОВИЯ, а не один такт. Первая редакция отдавала управление ровно на одну
   * макрозадачу (`setTimeout(…, 0)`) — и этого хватало, когда файл гоняли одного, но
   * не хватало в полном прогоне, где три проекта `vitest` делят процессор: тест мигал.
   * Мигающий тест хуже падающего — его перестают читать раньше, чем чинят.
   */
  async function submit(token: string) {
    const page = await openPage(token)
    await page.find('button[type="submit"]').trigger('submit')
    await vi.waitFor(() => {
      expect(page.text()).toContain('Спасибо!')
    })
    return page
  }

  it('до отправки вердикта нет ВООБЩЕ', async () => {
    // ⚠ ГЛАВНЫЙ ГВАРД. Решение владельца 23.09 против практики старого решения: там вердикт
    // пересчитывался живьём, пока респондент двигал ползунки, — то есть работал подсказкой
    // «как ответить, чтобы вышло хорошо». Здесь до отправки его нет ни в разметке, ни в теле
    // ответа: сервер присылает его ОДИН раз, в ответ на POST.
    const page = await openPage(TOKENS.verdict)

    expect(page.text()).not.toContain('Продолжаем двигаться вперед!')
    expect(page.find('.verdicts').exists()).toBe(false)
  })

  it('после отправки показывает текст и название секции', async () => {
    const page = await submit(TOKENS.verdict)

    expect(page.text()).toContain('Спасибо!')
    expect(page.text()).toContain('Продукт')
    expect(page.text()).toContain('Продолжаем двигаться вперед!')
  })

  it('без настроенных диапазонов блока нет', async () => {
    // Диапазоны заполнены у одной анкеты из двенадцати. Пустой блок с полоской сверху
    // читался бы как недогрузившаяся страница.
    const page = await submit(TOKENS.plain)

    expect(page.text()).toContain('Спасибо!')
    expect(page.find('.verdicts').exists()).toBe(false)
  })
})
