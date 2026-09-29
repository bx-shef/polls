import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Проверки ИСХОДНИКА поля «Анкета», а не отрендеренного DOM (#84, п. 18).
 *
 * ⚠ Тот же приём и по той же причине, что `survey-result-source.test.ts`: DOM-проверка ловит `v-html`
 * только на подсунутых данных, а компилятор Vue превращает директиву в присваивание `innerHTML`.
 * Формулировки анкеты набрал сотрудник на портале — правило проекта про такой текст.
 */

const SOURCE = readFileSync(new URL('../../app/pages/uf/survey-form.vue', import.meta.url), 'utf8')
/** Каркас фрейма, общий у обоих полей своего типа: связь с порталом живёт в нём (PR #100). */
const PLUMBING = readFileSync(new URL('../../app/composables/useFieldWidget.ts', import.meta.url), 'utf8')

describe('исходник поля «Анкета»', () => {
  it('не строит разметку из данных', () => {
    // Директива, а не упоминание: в комментарии страницы `v-html` назван как запрет.
    expect(SOURCE).not.toMatch(/v-html\s*=/)
    expect(SOURCE).not.toMatch(/innerHTML/)
  })

  it('не пишет значение в поле', () => {
    // ⚠ Нередактируемость поля держится на том, что `setValue` не зовётся нигде.
    for (const source of [SOURCE, PLUMBING]) {
      expect(source).not.toMatch(/\.setValue\s*\(/)
      expect(source).not.toMatch(/placement\.call\s*\(/)
    }
  })
})
