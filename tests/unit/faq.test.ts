import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'vue/compiler-sfc'
import { describe, expect, it } from 'vitest'
import { FAQ, FAQ_AGENT_PROMPT, FAQ_INTRO, UNINSTALL_PROMISE, buildLlmsTxt } from '../../shared/faq'

/**
 * Справка — ОДИН источник на две поверхности: страницу `/help` и `/llms.txt` для ИИ-помощника.
 *
 * Тест держит ровно это: обе стороны говорят одно и то же, якоря годятся для ссылок, а ссылки
 * «Что это значит?» из интерфейса ведут в существующие разделы. Приём и половина проверок — у соседнего
 * проекта (`client-bank-alfa-by`, `tests/faq.test.ts`).
 */

const SITE = 'https://polls.bx-shef.by'

describe('справка', () => {
  it('якоря уникальны и пригодны для адреса', () => {
    // ⚠ Якорь уезжает в адрес и в `place` слайдера. Кириллица или пробел означали бы процентное
    // кодирование в ссылке, которую человек пересылает в чат.
    const ids = FAQ.map(entry => entry.id)
    expect(new Set(ids).size, 'дублирующийся якорь — ссылка ведёт не туда').toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/)
  })

  it('у каждого раздела есть вопрос и непустой ответ', () => {
    for (const entry of FAQ) {
      expect(entry.question.trim().length, entry.id).toBeGreaterThan(0)
      expect(entry.answer.length, `${entry.id}: пустой ответ`).toBeGreaterThan(0)
      for (const paragraph of entry.answer) expect(paragraph.trim().length, entry.id).toBeGreaterThan(0)
    }
  })

  it('текст ПЛОСКИЙ — без разметки', () => {
    // ⚠ Разметка в источнике заставила бы одну из сторон её вырезать, а вырезают такое обычно
    // регуляркой, которая однажды съест не то. `llms.txt` — простой текст по устройству.
    const all = [FAQ_INTRO, FAQ_AGENT_PROMPT, ...FAQ.flatMap(entry => [entry.question, ...entry.answer])]
    for (const text of all) {
      expect(text, 'HTML в справке').not.toMatch(/<[a-z/]/i)
      expect(text, 'заголовок или список разметки в справке').not.toMatch(/(^|\n)\s*(#|[*-]\s)/)
    }
  })

  it('обещание про удаление приложения — дословно то, что записано в PROCESS.md', () => {
    // ⚠ `docs/PROCESS.md`, раздел 10: формулировка обязана попасть в справку целиком, а не
    // пересказом — «пересказ обещания — это уже другое обещание». Тест сверяет побуквенно,
    // чтобы правка одной из сторон не развела их молча.
    //
    // Берём ровно ОДИН блок цитаты — сплошные строки с `> ` сразу под маркером. Первая редакция
    // собирала их до конца документа, и любая цитата в разделах ниже приклеивалась к обещанию.
    // Нашли `/review` и `/code-review` в PR #82.
    const doc = readFileSync(new URL('../../docs/PROCESS.md', import.meta.url), 'utf8')
    const marker = 'Формулировка ниже — источник для справки'
    expect(doc, `в PROCESS.md нет маркера «${marker}»`).toContain(marker)

    const after = doc.slice(doc.indexOf(marker)).split('\n')
    const start = after.findIndex(line => line.startsWith('> '))
    const block = after.slice(start)
    const end = block.findIndex(line => !line.startsWith('> '))
    const quoted = block.slice(0, end === -1 ? block.length : end).map(line => line.slice(2).trim()).join(' ')

    expect(UNINSTALL_PROMISE).toBe(quoted)
    expect(FAQ.find(entry => entry.id === 'uninstall')!.answer).toContain(UNINSTALL_PROMISE)
  })
})

describe('llms.txt', () => {
  it('несёт ВЕСЬ текст справки, а не выжимку', () => {
    // ⚠ Это и есть проверка «одного источника»: выборочный экспорт — тот самый способ, которым
    // копия для помощника расходится с человеческой молча.
    const txt = buildLlmsTxt(SITE)
    expect(txt).toContain(FAQ_INTRO)
    expect(txt).toContain(FAQ_AGENT_PROMPT)
    for (const entry of FAQ) {
      expect(txt, `нет вопроса ${entry.id}`).toContain(entry.question)
      for (const paragraph of entry.answer) expect(txt, `нет абзаца из ${entry.id}`).toContain(paragraph)
    }
  })

  it('указывает на справку по публичному адресу', () => {
    expect(buildLlmsTxt(SITE)).toContain(`${SITE}/help`)
    expect(buildLlmsTxt(`${SITE}/`)).toContain(`${SITE}/help`)
  })

  it('без адреса ссылок нет вовсе, а не относительных', () => {
    // Относительная ссылка в документе, который читает чужой помощник, ведёт в никуда.
    const txt = buildLlmsTxt('')
    expect(txt).not.toContain('Справка:')
    expect(txt).toContain(FAQ_INTRO)
  })

  it('заканчивается ровно одним переводом строки', () => {
    const txt = buildLlmsTxt(SITE)
    expect(txt.endsWith('\n')).toBe(true)
    expect(txt.endsWith('\n\n')).toBe(false)
  })
})

/**
 * Ссылки «Что это значит?» из интерфейса ведут в СУЩЕСТВУЮЩИЕ разделы.
 *
 * ⚠ Якорь в ссылке и `id` в справке живут в разных файлах, и переименование раздела ломает ссылку
 * молча: неизвестный якорь честно открывает справку с начала, то есть поломка выглядит как
 * «открылось, но не там». Этот тест находит её до выката.
 *
 * ⚠ Шаблон разбирается КОМПИЛЯТОРОМ Vue, а не регуляркой. Первая редакция искала `anchor="…"`
 * регулярным выражением, и оно обрывалось на первом `>` внутри тега: `<HelpLink v-if="n > 0"
 * anchor="нет-такого" />` не находился вовсе, и битый якорь проходил зелёным. Нашли `/code-review`
 * и тестировщик в PR #82.
 */
describe('контекстные ссылки в справку', () => {
  const appDir = fileURLToPath(new URL('../../app', import.meta.url))

  function vueFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry)
      return statSync(full).isDirectory() ? vueFiles(full) : full.endsWith('.vue') ? [full] : []
    })
  }

  interface TemplateNode { type: number, tag?: string, props?: { type: number, name: string, value?: { content: string }, arg?: { content: string } }[], children?: TemplateNode[] }

  /** Все `<HelpLink>` файла: статический якорь либо `null`, если он задан биндингом. */
  function helpLinks(file: string): { file: string, anchor: string | null }[] {
    const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file })
    const found: { file: string, anchor: string | null }[] = []
    const walk = (node: TemplateNode) => {
      if (node.type === 1 && node.tag === 'HelpLink') {
        const plain = node.props?.find(prop => prop.type === 6 && prop.name === 'anchor')
        found.push({ file, anchor: plain?.value?.content ?? null })
      }
      for (const child of node.children ?? []) walk(child)
    }
    if (descriptor.template?.ast) walk(descriptor.template.ast as unknown as TemplateNode)
    return found
  }

  const links = vueFiles(appDir).flatMap(helpLinks)

  it('в интерфейсе вообще есть такие ссылки — иначе проверка ничего не проверяет', () => {
    // ⚠ Без этого тест остаётся зелёным, если компонент переименуют: пустой список проходит
    // любой `every`.
    expect(links.length).toBeGreaterThanOrEqual(5)
  })

  it('якорь задан строкой, а не выражением', () => {
    // Выражение проверить нечем: его значение станет известно только во время работы.
    for (const { file, anchor } of links) expect(anchor, `${file}: якорь задан биндингом`).not.toBeNull()
  })

  it('каждая ведёт в раздел, который есть', () => {
    const ids = new Set(FAQ.map(entry => entry.id))
    for (const { file, anchor } of links) {
      expect(ids.has(anchor ?? ''), `${file}: раздела «${anchor}» в справке нет`).toBe(true)
    }
  })

  it('находит ссылку и за атрибутом с «>» внутри', () => {
    // Ровно тот случай, на котором сломалась регулярка первой редакции.
    const probe = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'fixtures', 'help-link-probe.vue')
    expect(helpLinks(probe)).toEqual([{ file: probe, anchor: 'no-such-section' }])
  })
})
