import { mountSuspended } from '@nuxt/test-utils/runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FAQ, FAQ_AGENT_PROMPT } from '../../shared/faq'

/**
 * Справка и кнопка «Что это значит?» в окружении Nuxt.
 *
 * Страница — только отображение `shared/faq.ts`; то, что текст один на страницу и `llms.txt`,
 * держит `tests/unit/faq.test.ts`. Здесь — то, что без смонтированного компонента не проверить:
 * страница показывает все разделы с якорями, а кнопка открывает справку слайдером портала
 * и не молчит вне его.
 */

let frameWorks = true
const opened = vi.fn(async (_params: Record<string, unknown>) => {})

vi.mock('@bitrix24/b24jssdk', () => ({
  initializeB24Frame: async () => {
    if (!frameWorks) throw new Error('нет связи с порталом')
    return { slider: { openSliderAppPage: opened } }
  },
}))

beforeEach(() => {
  frameWorks = true
  opened.mockClear()
})

async function settle() {
  for (let tick = 0; tick < 6; tick += 1) await new Promise(resolve => setTimeout(resolve, 0))
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

describe('кнопка «Что это значит?»', () => {
  async function mountLink() {
    const HelpLink = (await import('../../app/components/HelpLink.vue')).default
    return mountSuspended(HelpLink, { props: { anchor: 'scores' } })
  }

  it('в портале открывает справку слайдером — сразу на нужном разделе', async () => {
    const link = await mountLink()

    await link.find('[data-testid="help-link"]').trigger('click')
    await settle()

    expect(opened).toHaveBeenCalledWith({ place: 'help-scores', bx24_width: 720, bx24_title: 'Справка' })
  })

  it('вне портала открывает справку в новой вкладке, а не молчит', async () => {
    // ⚠ Кнопка, которая молча ничего не делает, снаружи неотличима от поломки.
    frameWorks = false
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const link = await mountLink()

    await link.find('[data-testid="help-link"]').trigger('click')
    await settle()

    expect(opened).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith('/help#scores', '_blank', 'noopener')
    open.mockRestore()
  })
})
