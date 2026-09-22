/**
 * Per-request CSP nonce for the pages an outsider opens.
 *
 * ⚠ ЗАЧЕМ. Публичная страница анкеты — единственная, где текст, введённый сотрудником
 * на портале, читает ПОСТОРОННИЙ респондент. Первый рубеж — то, что разметки там не бывает
 * вовсе: всё рендерится интерполяцией `{{ }}`, без `v-html` и без библиотеки разметки.
 * CSP — второй рубеж, страхующий первый: если у экранирования окажется дефект, `unsafe-inline`
 * даст инлайновому `<script>` отработать беспрепятственно, а nonce — нет.
 *
 * ⚠ `unsafe-inline` стоял там не по небрежности: Nuxt встраивает в страницу исполняемые
 * инлайновые скрипты, и без них она не оживёт. Что именно встраивается — посмотрено
 * на собранном приложении, а не взято из головы: `window.__NUXT__` с конфигурацией,
 * `<script type="importmap">` и блок payload `type="application/json"`. Первые два
 * исполняются, третий — данные; nonce получают все три, лишний атрибут ничего не стоит.
 */
import { randomBytes } from 'node:crypto'

/** Длина nonce в байтах. 128 бит — минимум, который рекомендует спецификация CSP. */
const NONCE_BYTES = 16

/** Новый nonce. Обязан быть непредсказуемым и РАЗНЫМ на каждый ответ. */
export function createNonce(): string {
  return randomBytes(NONCE_BYTES).toString('base64')
}

/**
 * Проставить `nonce` каждому тегу `<script>` в разметке.
 *
 * ⚠ РАЗБИРАЕМ ТАК ЖЕ, КАК БРАУЗЕР, а не заменой по строке. Слепой `replaceAll('<script')`
 * попал бы внутрь блока payload — а в нём лежит текст анкеты, который писал сотрудник
 * портала. Вставив туда атрибут, мы бы испортили JSON и страница не ожила бы; хуже того,
 * сломанная разметка — это сам по себе способ вылезти за границы тега.
 *
 * Поэтому проход телом: найдя открывающий тег, прыгаем сразу за закрывающий. Внутри тела
 * скрипта `<script` — это текст, а не тег, и браузер понимает его ровно так же. Опереться
 * на это можно потому, что литеральный `</script>` внутри тела невозможен в принципе:
 * он закончил бы блок, и любой сериализатор обязан его экранировать. То есть наша граница
 * блока и браузерная — одна и та же.
 */
export function addNonceToScripts(html: string, nonce: string): string {
  const TAG = '<script'
  let out = ''
  let at = 0

  while (at < html.length) {
    const open = html.indexOf(TAG, at)
    if (open === -1) break

    // `<scriptfoo` тегом скрипта не является. Без этой проверки атрибут уехал бы в чужой тег.
    const after = html[open + TAG.length]
    if (after !== undefined && after !== '>' && !/\s/.test(after)) {
      out += html.slice(at, open + TAG.length)
      at = open + TAG.length
      continue
    }

    const tagEnd = html.indexOf('>', open)
    if (tagEnd === -1) break

    const tag = html.slice(open, tagEnd + 1)
    out += html.slice(at, open)
    // Повторно не добавляем: разметка могла прийти с nonce от другого слоя.
    out += /\snonce\s*=/.test(tag) ? tag : `${TAG} nonce="${nonce}"${tag.slice(TAG.length)}`

    // Тело до закрывающего тега переносим как есть. `</script` под `indexOf('<script')`
    // не попадает, поэтому следующий виток найдёт именно следующий открывающий тег.
    const close = html.indexOf('</script', tagEnd + 1)
    if (close === -1) {
      at = tagEnd + 1
      break
    }
    out += html.slice(tagEnd + 1, close)
    at = close
  }

  return out + html.slice(at)
}
