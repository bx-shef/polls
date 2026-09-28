import { mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FAQ, FAQ_AGENT_PROMPT } from '../../shared/faq'
import { mountInShell } from './in-shell'

/**
 * Справка и значок справки (`HelpLink`) в окружении Nuxt.
 *
 * Страница — только отображение `shared/faq.ts`; то, что текст один на страницу и `llms.txt`,
 * держит `tests/unit/faq.test.ts`. Здесь — то, что без смонтированного компонента не проверить:
 * страница показывает все разделы с якорями, а значок открывает справку слайдером портала
 * и не молчит вне его.
 */

let frameWorks = true
/**
 * Как портал отвечает на просьбу открыть слайдер.
 *
 * ⚠ По умолчанию — НИКАК, пока слайдер не закроют: так ведёт себя настоящий портал, и промис
 * висит всё время, пока человек читает справку. Подделка, отвечающая сразу, скрывала бы, что кнопка
 * ждёт завершения, — именно так первая редакция и прошла тесты с недостижимым запасным путём.
 */
let answer: () => Promise<unknown> = () => new Promise(() => {})
const opened = vi.fn((_params: Record<string, unknown>) => answer())

vi.mock('@bitrix24/b24jssdk', () => ({
  initializeB24Frame: async () => {
    if (!frameWorks) throw new Error('нет связи с порталом')
    return { slider: { openSliderAppPage: opened } }
  },
}))

/** Новая вкладка браузера — запасной путь кнопки. Подменена на каждый тест и снимается в `afterEach`. */
let newTab = vi.spyOn(window, 'open').mockImplementation(() => null)

beforeEach(() => {
  frameWorks = true
  answer = () => new Promise(() => {})
  opened.mockClear()
  newTab = vi.spyOn(window, 'open').mockImplementation(() => null)
})

afterEach(() => {
  // В `afterEach`, а не в конце теста: упавшая проверка иначе оставила бы подмену на весь файл.
  newTab.mockRestore()
})

async function settle() {
  for (let tick = 0; tick < 6; tick += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

/** Дольше, чем кнопка ждёт быстрого ответа портала (`SLIDER_ANSWER_MS`). */
async function outwait() {
  await new Promise(resolve => setTimeout(resolve, 1100))
}

describe('страница справки', () => {
  it('показывает каждый раздел под своим якорем и оглавление на все', async () => {
    const Help = (await import('../../app/pages/help.vue')).default
    const page = await mountSuspended(Help, { route: '/help' })

    const sections = page.findAll('[data-testid="faq-entry"]')
    expect(sections.map(section => section.attributes('id'))).toEqual(FAQ.map(entry => entry.id))
    expect(page.findAll('[data-testid="faq-toc"] a')).toHaveLength(FAQ.length)
    for (const entry of FAQ) expect(page.text()).toContain(entry.question)
  })

  it('отдаёт инструкцию для ИИ-помощника целиком', async () => {
    const Help = (await import('../../app/pages/help.vue')).default
    const page = await mountSuspended(Help, { route: '/help' })

    expect(page.find('[data-testid="faq-agent"] pre').text()).toBe(FAQ_AGENT_PROMPT)
  })
})

describe('копирование инструкции для ИИ-помощника', () => {
  /**
   * Буфер обмена, как его видит справка в слайдере портала: фрейм без `clipboard-write`,
   * Clipboard API отказывает. `execCommand` отвечает тем, что задал сценарий.
   */
  let execCopies: boolean

  beforeEach(() => {
    execCopies = true
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

  async function copyPrompt() {
    const Help = (await import('../../app/pages/help.vue')).default
    const page = await mountSuspended(Help, { route: '/help' })
    await page.find('[data-testid="faq-agent-copy"]').trigger('click')
    await settle()
    return page
  }

  it('в слайдере портала копирует запасным путём, а не молчит (issue #84)', async () => {
    // ⚠ Кнопка звала `navigator.clipboard` напрямую и глотала отказ: внутри портала, откуда
    // справку и открывают значком, она не копировала никогда.
    const page = await copyPrompt()

    expect(page.find('[data-testid="faq-agent-copy"]').text()).toBe('Скопировано')
    expect(page.find('[data-testid="faq-agent-copy-hint"]').exists()).toBe(false)
  })

  it('не вышло ни одним путём — говорит, как скопировать руками', async () => {
    execCopies = false
    const page = await copyPrompt()

    expect(page.find('[data-testid="faq-agent-copy"]').text()).toBe('Скопировать инструкцию')
    expect(page.find('[data-testid="faq-agent-copy-hint"]').text()).toContain('Ctrl+C')
  })
})

describe('значок справки', () => {
  async function mountLink(props: Record<string, unknown> = { anchor: 'scores' }) {
    const HelpLink = (await import('../../app/components/HelpLink.vue')).default
    return mountInShell(HelpLink, { props })
  }

  it('это КНОПКА с именем, а не голый значок', async () => {
    // ⚠ Образец из документации набора — голый `HelpIcon` в подсказке. Такой значок не получает
    // фокуса, не нажимается с клавиатуры, диктор его не называет, а на телефоне у него нет
    // наведения. Имя кнопки — тот же текст, что в подсказке: раньше он был подписью ссылки.
    const link = await mountLink({ anchor: 'scores', label: 'Как читать баллы?' })
    const button = link.find('[data-testid="help-link"]')

    expect(button.element.tagName).toBe('BUTTON')
    expect(button.attributes('type')).toBe('button')
    expect(button.attributes('aria-label')).toBe('Как читать баллы?')
  })

  it('без подписи зовётся «Что это значит?»', async () => {
    const link = await mountLink()

    expect(link.find('[data-testid="help-link"]').attributes('aria-label')).toBe('Что это значит?')
  })

  it('в портале открывает справку слайдером — сразу на нужном разделе', async () => {
    const link = await mountLink()

    await link.find('[data-testid="help-link"]').trigger('click')
    await settle()

    expect(opened).toHaveBeenCalledWith({ place: 'help-scores', bx24_width: 720, bx24_title: 'Справка' })
  })

  it('пока слайдер открыт, новую вкладку не открывает', async () => {
    // Портал молчит, пока слайдер не закроют, — это штатно, а не отказ.
    const link = await mountLink()

    await link.find('[data-testid="help-link"]').trigger('click')
    await outwait()

    expect(newTab).not.toHaveBeenCalled()
  })

  it.each<[string, () => Promise<unknown>]>([
    ['ответ-ошибка, как в мобильном клиенте', async () => ({ result: 'error', errorCode: 'METHOD_NOT_SUPPORTED_ON_DEVICE' })],
    ['исключение', async () => { throw new Error('портал отказал') }],
  ])('в портале, получив отказ, открывает новую вкладку (%s)', async (_case, refusal) => {
    // ⚠ Главный случай кнопки. Первая редакция ждала завершения промиса, и внутри портала запасной
    // путь был недостижим: кнопка молчала. Нашли `/review`, `/code-review` и тестировщик в PR #82.
    answer = refusal
    const link = await mountLink()

    await link.find('[data-testid="help-link"]').trigger('click')
    await settle()

    expect(opened).toHaveBeenCalled()
    expect(newTab).toHaveBeenCalledWith('/help#scores', '_blank', 'noopener')
  })

  it('вне портала открывает справку в новой вкладке, а не молчит', async () => {
    frameWorks = false
    const link = await mountLink()

    await link.find('[data-testid="help-link"]').trigger('click')
    await settle()

    expect(opened).not.toHaveBeenCalled()
    expect(newTab).toHaveBeenCalledWith('/help#scores', '_blank', 'noopener')
  })

  it('двойной щелчок не просит второй слайдер', async () => {
    // Иначе поверх вкладки легли бы два одинаковых слайдера. Нашёл `/code-review`.
    const link = await mountLink()
    const button = link.find('[data-testid="help-link"]')

    await button.trigger('click')
    await button.trigger('click')
    await settle()

    expect(opened).toHaveBeenCalledTimes(1)
  })
})
