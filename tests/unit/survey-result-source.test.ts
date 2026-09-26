import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Проверки ИСХОДНИКА виджета результата, а не отрендеренного DOM.
 *
 * ⚠ Гвард под находку безопасности в панели ревью PR #80. Страница выводит ответы клиента —
 * текст постороннего человека — в карточке, которую читает сотрудник. DOM-проверка в
 * `tests/nuxt/survey-result.test.ts` ловит `v-html` на подсунутом ответе, но проект уже знает,
 * что одной её мало: компилятор Vue превращает директиву в присваивание `innerHTML`, и у лендинга
 * такая проверка была зелёной при живом `v-html` (панель ревью PR #28, `landing-source.test.ts`).
 * Здесь — тот же приём по исходнику.
 */

const SOURCE = readFileSync(new URL('../../app/pages/uf/survey-result.vue', import.meta.url), 'utf8')

describe('исходник виджета результата', () => {
  it('не строит разметку из данных', () => {
    // Директива, а не упоминание: в комментарии страницы `v-html` назван как запрет.
    expect(SOURCE).not.toMatch(/v-html\s*=/)
    expect(SOURCE).not.toMatch(/innerHTML/)
  })

  it('не пишет значение в поле', () => {
    // ⚠ Нередактируемость поля держится ровно на том, что `setValue` не зовётся нигде.
    // DOM-тест ловит вызов в пройденной ветке; этот — в любой.
    // Вызов, а не упоминание: в комментарии страницы `setValue` назван как то, чего нет.
    expect(SOURCE).not.toMatch(/\.setValue\s*\(/)
    expect(SOURCE).not.toMatch(/placement\.call\s*\(/)
  })
})
