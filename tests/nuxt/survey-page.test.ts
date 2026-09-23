import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { defineEventHandler, setResponseStatus } from 'h3'
import { describe, expect, it } from 'vitest'
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
 * У каждого сценария свой токен, и это не украшательство: `useFetch` кэширует ответ
 * по ключу запроса, и общий токен отдал бы всем тестам результат первого.
 */
const TOKENS = {
  survey: 'a'.repeat(43),
  expired: 'b'.repeat(43),
  limited: 'c'.repeat(43),
  broken: 'd'.repeat(43),
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

serve(TOKENS.survey, SURVEY)
serve(TOKENS.expired, { ok: false, reason: 'expired', title: 'Срок ссылки истёк', detail: 'Попросите новую.' })
serve(TOKENS.limited, { ok: false, reason: 'rate-limited', title: 'Слишком много попыток', detail: 'Подождите минуту.' }, 429)
serve(TOKENS.broken, { statusCode: 503, statusMessage: 'Not configured' }, 503)

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

  it('рендерит текст с портала текстом, а не разметкой', async () => {
    // Формулировку пишет сотрудник портала, читает посторонний респондент — прямой путь
    // для XSS. Закрыт тем, что разметки здесь не бывает вовсе: только `{{ }}`.
    const page = await openPage(TOKENS.survey)

    expect(page.html()).not.toContain('<script>alert(1)</script>')
    expect(page.text()).toContain('<script>alert(1)</script>')
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
