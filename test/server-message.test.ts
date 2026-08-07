import { describe, it, expect } from 'vitest'
import { serverMessage, MAX_SERVER_MESSAGE } from '../src/client/server-message'

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

  it('обрезает пробелы по краям', () => {
    expect(serverMessage({ data: { error: '  Опрос не найден.  ' } })).toBe('Опрос не найден.')
  })

  it('игнорирует ответ без тела — обрыв сети, брошенный createError', () => {
    // `requirePortalSession` бросает createError без `data`: страница обязана показать свою строку.
    expect(serverMessage({ statusCode: 401, statusMessage: 'Unauthorized' })).toBeUndefined()
    expect(serverMessage(new Error('network'))).toBeUndefined()
    expect(serverMessage(undefined)).toBeUndefined()
    expect(serverMessage(null)).toBeUndefined()
  })

  it('игнорирует чужой формат тела', () => {
    // Страница ошибки прокси, тело h3 (`message`/`statusMessage`), успех без ошибки.
    expect(serverMessage({ data: '<html>502 Bad Gateway</html>' })).toBeUndefined()
    expect(serverMessage({ data: { message: 'Bad Gateway' } })).toBeUndefined()
    expect(serverMessage({ data: { error: 42 } })).toBeUndefined()
    expect(serverMessage({ data: { error: { text: 'нет' } } })).toBeUndefined()
  })

  it('игнорирует пустую строку и строку из одних пробелов', () => {
    // Иначе алерт показал бы пустую рамку вместо объяснения.
    expect(serverMessage({ data: { error: '' } })).toBeUndefined()
    expect(serverMessage({ data: { error: '   \n\t ' } })).toBeUndefined()
  })

  it('не пропускает блоб: длина ровно на пределе проходит, на символ больше — нет', () => {
    // Прокси может вернуть JSON с гигантским текстом; в интерфейсе респондента ему не место.
    expect(serverMessage({ data: { error: 'я'.repeat(MAX_SERVER_MESSAGE) } })).toHaveLength(MAX_SERVER_MESSAGE)
    expect(serverMessage({ data: { error: 'я'.repeat(MAX_SERVER_MESSAGE + 1) } })).toBeUndefined()
  })

  it('меряет длину ПОСЛЕ обрезки пробелов', () => {
    // Иначе отступы в теле съедали бы лимит и глушили нормальное сообщение.
    const padded = `   ${'я'.repeat(MAX_SERVER_MESSAGE)}   `
    expect(serverMessage({ data: { error: padded } })).toHaveLength(MAX_SERVER_MESSAGE)
  })

  it('все наши тексты отказа укладываются в предел', async () => {
    // Гард от расхождения: предел выставлен здесь, а строки живут в handlers.ts и растут отдельно.
    const src = await import('node:fs').then((fs) => fs.readFileSync('src/api/handlers.ts', 'utf8'))
    const texts = [...src.matchAll(/err\(\d{3}, '([^']+)'\)/g)].map((m) => m[1] ?? '')
    expect(texts.length).toBeGreaterThan(10) // регулярка ещё находит строки (файл не переписан)
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(MAX_SERVER_MESSAGE)
  })
})
