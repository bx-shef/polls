import { describe, expect, it } from 'vitest'
import {
  TEMPLATE_FORM_FIELD,
  TEMPLATE_FORM_SECTION,
  buildFieldName,
  buildTemplateCardSections,
  planTemplateCard,
} from '../../server/domain/portals/smart-processes'

/**
 * Карточка «Шаблона опроса»: поле «Анкета» вместо схемы-JSON (#84, п. 18, ревизия 7).
 *
 * Чистые функции, без портала. Правила — те же, что у карточки «Результата опросов»
 * (`userfield-type.test.ts`, «ревизия 6»): здесь держим то, чем карточка «Шаблона» от неё отличается.
 */

const TEMPLATE = { entityTypeId: 1044, id: 7 }
const f = (postfix: string) => buildFieldName(TEMPLATE.id, postfix)

/** The widget field is ours, the smart process is ours and on stages, the fix is due. */
const WIDGET = { widget: true, adopted: false, due: true, staged: true }

/** Names of every element, section by section — what goes back to the portal. */
function layoutOf(plan: ReturnType<typeof planTemplateCard>): string[][] {
  expect(plan.kind).toBe('write')
  return (plan as { sections: Record<string, unknown>[] }).sections.map(section => (section.elements as { name: string }[]).map(e => e.name))
}

/** Раскладка, как её собирает сам портал: «Об элементе» и «Дополнительно» со всеми нашими полями подряд. */
function portalDefault(): Record<string, unknown>[] {
  return [
    { name: 'main', title: 'Об элементе', type: 'section', elements: [{ name: 'TITLE' }] },
    { name: 'additional', title: 'Дополнительно', type: 'section', elements: ['CODE', 'VERSION', 'PUBLISHED_AT', 'SCHEMA'].map(postfix => ({ name: f(postfix) })) },
  ]
}

describe('раскладка «Шаблона» с нуля', () => {
  it('ГЛАВНОЕ: анкета — полем «Анкета» с «показывать всегда», схемы-JSON в карточке нет', () => {
    // ⚠ Значения у поля нет никогда, и без флага карточка прятала бы его в режиме просмотра.
    const sections = buildTemplateCardSections(TEMPLATE.id, true, true)
    const form = sections.find(section => section.name === TEMPLATE_FORM_SECTION)!

    expect(form.elements).toEqual([{ name: f(TEMPLATE_FORM_FIELD), optionFlags: 1 }])
    expect(JSON.stringify(sections)).not.toContain(f('SCHEMA'))
  })

  it('без поля «Анкета» — схема-JSON: без неё анкеты в карточке не было бы вовсе', () => {
    const form = buildTemplateCardSections(TEMPLATE.id, false, true).find(section => section.name === TEMPLATE_FORM_SECTION)!

    expect(form.elements).toEqual([{ name: f('SCHEMA') }])
  })

  it('код, номер версии и дата публикации — на виду; «Состояния» со стадиями нет', () => {
    const [about] = buildTemplateCardSections(TEMPLATE.id, true, true)
    const names = (about!.elements as { name: string }[]).map(e => e.name)

    expect(names).toEqual(['TITLE', f('CODE'), f('VERSION'), f('PUBLISHED_AT'), 'ASSIGNED_BY_ID'])
    expect(JSON.stringify(buildTemplateCardSections(TEMPLATE.id, true, false))).toContain(f('STATE'))
  })

  it('ставится на пустом месте при любой ревизии — но не усыновлённому', () => {
    // До ревизии 7 раскладку «Шаблона» мы не ставили вовсе: пустое место здесь — почти каждый портал.
    const fresh = { kind: 'write', sections: buildTemplateCardSections(TEMPLATE.id, true, true) }

    expect(planTemplateCard({ result: null }, TEMPLATE.id, WIDGET)).toEqual(fresh)
    expect(planTemplateCard({ result: null }, TEMPLATE.id, { ...WIDGET, due: false })).toEqual(fresh)
    expect(planTemplateCard({ result: null }, TEMPLATE.id, { ...WIDGET, adopted: true })).toEqual({ kind: 'foreign' })
  })
})

describe('ревизия 7: поле «Анкета» в раскладке, которая уже стоит', () => {
  it('ГЛАВНОЕ: раскладка портала — «Анкета» встаёт на место схемы, схема уходит, остальное как было', () => {
    const plan = planTemplateCard({ result: portalDefault() }, TEMPLATE.id, WIDGET)

    expect(layoutOf(plan)).toEqual([['TITLE'], [f('CODE'), f('VERSION'), f('PUBLISHED_AT'), f(TEMPLATE_FORM_FIELD)]])
  })

  it('ГЛАВНОЕ: без поля «Анкета» схема не снимается — и ставить нечего', () => {
    expect(planTemplateCard({ result: portalDefault() }, TEMPLATE.id, { ...WIDGET, widget: false })).toEqual({ kind: 'keep' })
  })

  it('чужих полей «Результата» — ссылки на анкету — в карточку «Шаблона» не ставит', () => {
    // Правила у карточек общие, а поля — свои: «Ссылка на анкету» живёт только у «Результата опросов».
    const plan = planTemplateCard({ result: portalDefault() }, TEMPLATE.id, WIDGET)

    expect(JSON.stringify(plan)).not.toContain('LINK')
  })

  it('резервные якоря: после даты публикации, версии, кода, а их нет — в конец первого раздела', () => {
    const layout = (elements: string[]) => [{ name: 'mine', title: 'Моё', type: 'section', elements: [{ name: 'TITLE' }, ...elements.map(name => ({ name }))] }]

    expect(layoutOf(planTemplateCard({ result: layout([f('CODE'), f('VERSION'), f('PUBLISHED_AT'), 'COMMENTS']) }, TEMPLATE.id, WIDGET))[0])
      .toEqual(['TITLE', f('CODE'), f('VERSION'), f('PUBLISHED_AT'), f(TEMPLATE_FORM_FIELD), 'COMMENTS'])
    expect(layoutOf(planTemplateCard({ result: layout([f('CODE'), 'COMMENTS']) }, TEMPLATE.id, WIDGET))[0])
      .toEqual(['TITLE', f('CODE'), f(TEMPLATE_FORM_FIELD), 'COMMENTS'])
    expect(layoutOf(planTemplateCard({ result: layout(['COMMENTS']) }, TEMPLATE.id, WIDGET))[0])
      .toEqual(['TITLE', 'COMMENTS', f(TEMPLATE_FORM_FIELD)])
  })

  it('стоящее поле «Анкета» не двигает — только добавляет «показывать всегда»', () => {
    const layout = portalDefault()
    ;(layout[0]!.elements as Record<string, unknown>[]).push({ name: f(TEMPLATE_FORM_FIELD) })

    const plan = planTemplateCard({ result: layout }, TEMPLATE.id, WIDGET) as unknown as { sections: { elements: Record<string, unknown>[] }[] }

    expect(plan.sections[0]!.elements).toEqual([{ name: 'TITLE' }, { name: f(TEMPLATE_FORM_FIELD), optionFlags: 1 }])
    expect(JSON.stringify(plan.sections[1])).not.toContain(f('SCHEMA'))
  })

  it('всё уже на месте — писать нечего; правка не положена — тоже', () => {
    const settled = (planTemplateCard({ result: portalDefault() }, TEMPLATE.id, WIDGET) as { sections: Record<string, unknown>[] }).sections

    expect(planTemplateCard({ result: settled }, TEMPLATE.id, WIDGET)).toEqual({ kind: 'keep' })
    expect(planTemplateCard({ result: portalDefault() }, TEMPLATE.id, { ...WIDGET, due: false })).toEqual({ kind: 'keep' })
  })

  it('ГЛАВНОЕ: у усыновлённого — только раскладку со своими полями', () => {
    // Найденный по названию «Шаблон опроса» может оказаться смарт-процессом клиента: в его карточку,
    // где наших полей нет, мы ничего не ставим.
    const client = [{ name: 'main', title: 'Мой шаблон', type: 'section', elements: [{ name: 'TITLE' }] }]

    expect(planTemplateCard({ result: client }, TEMPLATE.id, { ...WIDGET, adopted: true })).toEqual({ kind: 'foreign' })
    expect(planTemplateCard({ result: portalDefault() }, TEMPLATE.id, { ...WIDGET, adopted: true }).kind).toBe('write')
  })

  it('непонятную раскладку не пишет', () => {
    expect(planTemplateCard({ result: [{ name: 'main', type: 'section', elements: [] }] }, TEMPLATE.id, WIDGET)).toEqual({ kind: 'unreadable' })
    expect(planTemplateCard({ result: { 0: portalDefault()[0] } }, TEMPLATE.id, WIDGET)).toEqual({ kind: 'unreadable' })
  })
})
