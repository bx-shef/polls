import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serverMessage, MAX_SERVER_MESSAGE } from '../src/client/server-message'
import { draftTooLargeMessage } from '../src/domain/schema'

/**
 * Правило одно: пользователю показывается текст СЕРВЕРА, если сервер его прислал, и ничего —
 * если прислал что-то другое. Вызывающий подставит свой фолбэк.
 */
describe('serverMessage', () => {
  it('достаёт текст из тела ответа нашего API', () => {
    // Форма ошибки $fetch/useAsyncData: тело ответа лежит в `data`.
    const err = { statusCode: 403, data: { ok: false, error: 'Срок ссылки истёк или она недействительна.' } }
    expect(serverMessage(err)).toBe('Срок ссылки истёк или она недействительна.')
  })

  it('достаёт текст и из конверта брошенного createError (двойная вложенность)', () => {
    // Роут по конвенции проекта отвечает телом, но брошенный где-то выше `createError({ data })`
    // Nitro заворачивает ещё раз. Читать только первую форму = иногда показывать служебное значение.
    expect(serverMessage({ data: { data: { ok: false, error: 'Опрос не найден. Вернитесь к списку.' } } }))
      .toBe('Опрос не найден. Вернитесь к списку.')
  })

  it('прямая форма имеет приоритет над завёрнутой', () => {
    const err = { data: { ok: false, error: 'внешний', data: { error: 'внутренний' } } }
    expect(serverMessage(err)).toBe('внешний')
  })

  it('обрезает пробелы по краям', () => {
    expect(serverMessage({ data: { ok: false, error: '  Опрос не найден.  ' } })).toBe('Опрос не найден.')
  })

  it('схлопывает переводы строк — заголовок алерта однострочный', () => {
    // Иначе многострочное значение разъедет вёрстку алерта.
    expect(serverMessage({ data: { ok: false, error: 'Ссылка истекла.\n\nПопросите новую.' } }))
      .toBe('Ссылка истекла. Попросите новую.')
  })

  it('вычищает невидимые и переставляющие символы (Trojan Source)', () => {
    // Защита в глубину: текст пишем мы, но тело может перестать быть нашим (промежуточный прокси).
    // Экранирование Vue спасает от разметки, а не от переставленного смысла.
    expect(serverMessage({ data: { ok: false, error: 'до\u202eпосле' } })).toBe('допосле')
    expect(serverMessage({ data: { ok: false, error: 'a\u200bb\ufeffc' } })).toBe('abc')
    expect(serverMessage({ data: { ok: false, error: 'x\u{e0041}y' } })).toBe('xy')
  })

  it('игнорирует ответ без тела — обрыв сети, брошенный createError без data', () => {
    // `requirePortalSession` бросает createError только со `statusCode`/`statusMessage`:
    // страница обязана показать свою строку, а не английское служебное значение.
    expect(serverMessage({ statusCode: 401, statusMessage: 'Unauthorized' })).toBeUndefined()
    expect(serverMessage(new Error('network'))).toBeUndefined()
    expect(serverMessage(undefined)).toBeUndefined()
    expect(serverMessage(null)).toBeUndefined()
  })

  it('игнорирует чужой формат тела', () => {
    // Страница ошибки прокси, тело h3 (`message`/`statusMessage`), успех без ошибки.
    expect(serverMessage({ data: '<html>502 Bad Gateway</html>' })).toBeUndefined()
    expect(serverMessage({ data: { ok: false, message: 'Bad Gateway' } })).toBeUndefined()
    expect(serverMessage({ data: { ok: false, error: 42 } })).toBeUndefined()
    expect(serverMessage({ data: { ok: false, error: { text: 'нет' } } })).toBeUndefined()
  })

  it('игнорирует пустую строку и строку из одних пробелов', () => {
    // Иначе алерт показал бы пустую рамку вместо объяснения.
    expect(serverMessage({ data: { ok: false, error: '' } })).toBeUndefined()
    expect(serverMessage({ data: { ok: false, error: '   \n\t ' } })).toBeUndefined()
    expect(serverMessage({ data: { ok: false, error: '\u200b\u200b' } })).toBeUndefined() // осталось пусто после чистки
  })

  it('не пропускает блоб: длина ровно на пределе проходит, на символ больше — нет', () => {
    // Прокси может вернуть JSON с гигантским текстом; в интерфейсе респондента ему не место.
    // Сверяем ЗНАЧЕНИЕ, а не длину: реализация, которая обрезала бы длинный текст вместо отказа,
    // проверку по длине прошла бы.
    const atLimit = 'я'.repeat(MAX_SERVER_MESSAGE)
    expect(serverMessage({ data: { ok: false, error: atLimit } })).toBe(atLimit)
    expect(serverMessage({ data: { ok: false, error: 'я'.repeat(MAX_SERVER_MESSAGE + 1) } })).toBeUndefined()
  })

  it('меряет длину ПОСЛЕ чистки', () => {
    // Иначе отступы и невидимые символы съедали бы лимит и глушили нормальное сообщение.
    const atLimit = 'я'.repeat(MAX_SERVER_MESSAGE)
    expect(serverMessage({ data: { ok: false, error: `   ${atLimit}   ` } })).toBe(atLimit)
  })
})

/**
 * Связка с НАСТОЯЩИМ ответом сервера.
 *
 * Без неё все проверки выше разбирают объекты, которые сами же и придумали: поменяй ядро с
 * `{ ok:false, error }` на `{ ok:false, message }` — и юнит-тесты, и визуальный гейт останутся
 * зелёными, а респондент увидит общую заглушку. Поэтому берём тело, которое реально отдаёт
 * `createApi`, и прогоняем его через `serverMessage`.
 */
describe('контракт с ядром API', () => {
  it('текст отказа из реального ответа /api/submit доходит дословно', async () => {
    const { createApi } = await import('../src/api/handlers')
    const { MemoryStore } = await import('../src/store/memory')
    const api = createApi({ store: new MemoryStore() })

    // Повтор одноразового nonce — достижимый отказ: 409 «Этот ответ уже отправлен».
    const { nonce } = (await api.session({ ip: '1.1.1.1' })).body as { nonce: string }
    const body = { schema_version: 1, nonce, hp: '', surveyKey: 'нет-такого', versionNo: 1, answers: {} }
    await api.submit({ ip: '1.1.1.1', body })
    const replay = await api.submit({ ip: '1.1.1.1', body })

    expect(replay.status).toBe(409)
    expect(serverMessage({ data: replay.body })).toBe('Этот ответ уже отправлен — повторять не нужно.')
  })

  it('успешный ответ сообщением не считается', async () => {
    // `{ ok: true }` не должен подсовывать в алерт пустую строку.
    const { createApi } = await import('../src/api/handlers')
    const { MemoryStore } = await import('../src/store/memory')
    const api = createApi({ store: new MemoryStore() })
    const ok = await api.session({ ip: '2.2.2.2' })
    expect(serverMessage({ data: ok.body })).toBeUndefined()
  })
})

/**
 * Гард инварианта, на котором держится вся конструкция: текст, который мы показываем человеку,
 * пишем МЫ, а не отправитель запроса.
 *
 * Стоит структурно, а не «на глазок»: одна интерполяция вида `` err(404, `Опрос ${key} не найден`) ``
 * — и на нашей странице, под нашим доменом, появится текст постороннего. Экранирование Vue от этого
 * не защищает: оно закрывает разметку, а не смысл (готовая площадка для фишинга, плюс эхо токена или
 * данных CRM). Поэтому правило простое и проверяемое: **всякая русская строка в этих файлах —
 * обычный литерал, без подстановки, и не длиннее предела**.
 */
// Пути — от этого файла, а не от текущего каталога: иначе тест зависел бы от того, откуда запустили.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
// ⚠️ `server/utils` сканируется НАРАВНЕ с роутами, и это не «на всякий случай». Роуты дашборда и
// страницы результата вынесли свои решения в `server/utils/*-view.ts` вместе с текстами отказов — и
// гард, смотревший только в `server/api`, молча перестал их видеть: порог `seen > 30` набирался
// остальными роутами, поэтому ослабление прошло зелёным. Каталог целиком сканируется затем, чтобы
// следующий вынос не повторил это; файлы без `error:` дают ноль выражений и ничему не мешают.
const SCANNED = [
  join(ROOT, 'src/api/handlers.ts'),
  ...listServerRoutes(join(ROOT, 'server/api')),
  ...listServerRoutes(join(ROOT, 'server/utils'))
]

function listServerRoutes(dir: string): string[] {
  // Пробы линт-гейта (`__lint-probe.*`) исключаем: они появляются и исчезают в боевых каталогах во
  // время прогона, и попадание такой пробы в список даёт `ENOENT` при чтении — в чужом тесте и с
  // сообщением, по которому причину не найти. Сегодня пересечения нет, но правило дешевле.
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? listServerRoutes(join(dir, e.name))
      : e.name.endsWith('.ts') && !e.name.startsWith('__lint-probe') ? [join(dir, e.name)] : []
  )
}

/** Убрать комментарии — иначе русский текст пояснений считался бы сообщением пользователю. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * Выражения, которые становятся полем `error` ответа: значение после `error:` и второй аргумент
 * `err(<код>, …)`. Границу ищем скобочным проходом, а не регуляркой, потому что значение бывает
 * тернарным и многострочным — а нам нужно именно оно, и НЕ нужны соседние строки: логи рядом
 * (`logger.warn(..., { msg: `Сделка ${id}…` })`) подстановку содержат законно, в ответ не идут.
 */
function errorExpressions(code: string): string[] {
  const out: string[] = []
  const starts = [...code.matchAll(/\berror:\s*/g), ...code.matchAll(/\berr\(\d{3},\s*/g)]
  for (const m of starts) {
    let i = (m.index ?? 0) + m[0].length
    let depth = 0
    const from = i
    for (; i < code.length; i++) {
      const c = code[i]
      if (c === '{' || c === '(' || c === '[') depth++
      else if (c === '}' || c === ')' || c === ']') {
        if (depth === 0) break
        depth--
      } else if (c === ',' && depth === 0) break
    }
    out.push(code.slice(from, i))
  }
  return out
}

const CYRILLIC = /[а-яёА-ЯЁ]/

describe('тексты для пользователя пишет сервер и только литералами', () => {
  it('находит сами файлы (иначе гард был бы зелёным ни на чём)', () => {
    expect(SCANNED.length).toBeGreaterThan(8)
    expect(SCANNED.some((f) => f.endsWith('src/api/handlers.ts'))).toBe(true)
  })

  it('ни один текст отказа не собирается подстановкой', () => {
    let seen = 0
    for (const file of SCANNED) {
      const exprs = errorExpressions(stripComments(readFileSync(file, 'utf8')))
      seen += exprs.length
      const guilty = exprs.filter((e) => e.includes('`'))
      expect(guilty, `${file}: текст отказа собран шаблоном — его напишет отправитель запроса`).toEqual([])
    }
    expect(seen).toBeGreaterThan(30) // выражения действительно найдены, а не «ноль проверок»
  })

  it('шаблонный текст из ядра: подставляются ТОЛЬКО числа', () => {
    // Гард выше сканирует `error:` в handlers.ts и server/api/**. `draftTooLargeMessage` рождается в
    // ядре и мимо него проходит — то есть правило «текст пишем мы» держалось бы на честном слове.
    // Держим его отдельно и по существу: форма фиксирована, меняются лишь цифры.
    const SHAPE = 'Опрос слишком большой: # КБ при пределе # КБ. Сократите тексты вопросов или уменьшите их число.'
    for (const bytes of [0, 1, 61_440, 61_441, 9_999_999, Number.MAX_SAFE_INTEGER]) {
      const msg = draftTooLargeMessage(bytes)
      expect(msg.replace(/\d+/g, '#'), String(bytes)).toBe(SHAPE)
      expect(msg.length, `${bytes}: длиннее предела serverMessage`).toBeLessThanOrEqual(MAX_SERVER_MESSAGE)
    }
  })

  it('каждый текст отказа укладывается в предел serverMessage', () => {
    let checked = 0
    for (const file of SCANNED) {
      for (const expr of errorExpressions(stripComments(readFileSync(file, 'utf8')))) {
        for (const lit of expr.match(/'[^'\n]*'/g) ?? []) {
          const text = lit.slice(1, -1)
          if (!CYRILLIC.test(text)) continue
          checked++
          expect(text.length, `${file}: «${text.slice(0, 40)}…» длиннее ${MAX_SERVER_MESSAGE}`)
            .toBeLessThanOrEqual(MAX_SERVER_MESSAGE)
        }
      }
    }
    // Строки действительно найдены: без этого цикл мог бы просто не выполниться ни разу.
    expect(checked).toBeGreaterThan(30)
  })

  it('именованные константы отказа — тоже в пределе, и доходят целиком', async () => {
    // Они лежат вне сканируемых файлов (собраны конкатенацией, регулярка их не увидит), но приезжают
    // в те же тела ответа. ADMIN_REQUIRED_MESSAGE — 288 символов при пределе 300: до молчаливого
    // схлопывания в общий фолбэк ему одно предложение, поэтому проверяем не только длину, но и то,
    // что `serverMessage` отдаёт его ДОСЛОВНО.
    const { ADMIN_REQUIRED_MESSAGE } = await import('../src/api/session')
    const { CROSS_ORIGIN_MESSAGE } = await import('../src/api/csrf')
    for (const t of [ADMIN_REQUIRED_MESSAGE, CROSS_ORIGIN_MESSAGE]) {
      expect(t.length).toBeLessThanOrEqual(MAX_SERVER_MESSAGE)
      expect(serverMessage({ data: { ok: false, error: t } })).toBe(t)
    }
  })
})

describe('отказ при неоднозначном ключе опроса (#49)', () => {
  it('обе редакции текста говорят одно и то же и влезают в предел показа', () => {
    // ⚠️ Строк ДВЕ намеренно (для страницы и для отправки), и обе — литералы: собирать вторую из
    // первой запрещено гардом выше. Цена такого решения — риск, что их поправят по одной; его и
    // сторожит этот тест. Плюс предел `MAX_SERVER_MESSAGE`: длиннее — и клиент покажет вместо текста
    // общий фолбэк «проверьте подключение», уводящий ровно не туда.
    const src = readFileSync(join(ROOT, 'server/utils/tenant.ts'), 'utf8')
    const texts = [...src.matchAll(/AMBIGUOUS_[A-Z_]+MESSAGE\s*=\s*([\s\S]*?)\n\n/g)]
      .map((m) => [...m[1]!.matchAll(/'([^']*)'/g)].map((q) => q[1]).join(''))
    expect(texts).toHaveLength(2)
    for (const t of texts) {
      expect(t.length).toBeLessThanOrEqual(MAX_SERVER_MESSAGE)
      expect(t, 'редакции разошлись — человек получит разный совет на странице и на отправке')
        .toContain('Опрос доступен только по личной ссылке. Откройте ссылку из письма или из карточки сделки')
    }
    expect(texts[1]!.startsWith('Ответ не отправлен.'), 'на отправке первым идёт не «ответ не отправлен»').toBe(true)
  })
})
