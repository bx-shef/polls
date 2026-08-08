import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Гард гейта прав на роутах (по образцу `check-core-boundary`).
 *
 * Зачем читать исходники, а не звать роуты: `server/**` в этом проекте тестами не покрывается
 * (`vitest.config.ts` включает только `test/**` против `src/**`), поэтому единственная строка, ради
 * которой существует весь гейт, иначе остаётся вне любой проверки — вернуть публикацию на
 * `requirePortalSession` можно было бы, не уронив ни одного из ~700 тестов.
 *
 * Проверка грубая (текстовая), но ловит ровно два регресса, которые больше не ловит ничто:
 *  1. с публикации сняли гейт роли — вернулась дыра «любой сотрудник портала публикует опрос»;
 *  2. гейт роли навесили на ЧТЕНИЕ — сломали бы дашборд и конструктор рядовому сотруднику
 *     (он должен видеть аналитику; это прямо обещано в `docs/process.md`).
 */

const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8')

/** Роуты, меняющие конфигурацию опросов: только администратор портала. */
const WRITE_ROUTES = ['server/api/admin/surveys/[key]/publish.post.ts']

/** Роуты чтения: достаточно сессии портала, роль требовать НЕЛЬЗЯ. */
const READ_ROUTES = [
  'server/api/admin/surveys.get.ts',
  'server/api/admin/surveys/[key].get.ts',
  'server/api/dashboard/[key].get.ts'
]

/** Код без комментариев: иначе гард удовлетворяется упоминанием имени в прозе. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

describe('гейт прав на роутах (#139)', () => {
  it.each(WRITE_ROUTES)('%s требует роль администратора', (path) => {
    const src = read(path)
    expect(src).toContain('resolveAdminAccess')
    // Голый requirePortalSession на записи = та самая дыра, ради которой всё делалось.
    expect(src).not.toMatch(/^\s*requirePortalSession\(event\)/m)
  })

  it.each(WRITE_ROUTES)('%s проверяет происхождение запроса (cookie SameSite=None → CSRF)', (path) => {
    expect(read(path)).toContain('isSameOriginWrite')
  })

  it.each(READ_ROUTES)('%s гейтит сессией портала, но НЕ ролью администратора', (path) => {
    // ⚠️ Сверяем по коду БЕЗ комментариев и по факту ВЫЗОВА, а не по вхождению слова: гард уже успел
    // один раз выродиться — роут переехал с `requirePortalSession` на `resolvePortalSession`, а
    // прежнее имя осталось в комментарии, и проверка проходила на прозе. То есть гейт можно было
    // удалить целиком, не уронив ни одного теста, — ровно то, ради чего этот файл написан.
    const src = stripComments(read(path))
    expect(src, `${path}: нет вызова гейта сессии портала`).toMatch(/\b(require|resolve)PortalSession\(event\)/)
    expect(src).not.toContain('resolveAdminAccess')
  })

  it.each(READ_ROUTES)('%s гейтит ДО обращения к хранилищу (не тратим работу на отказ)', (path) => {
    const src = stripComments(read(path))
    const gate = src.search(/\b(require|resolve)PortalSession\(event\)/)
    const store = src.indexOf('useStore(')
    if (store < 0) return // роут в стор не ходит — проверять нечего
    expect(gate, `${path}: обращение к хранилищу раньше гейта`).toBeLessThan(store)
  })

  it('гейт записи стоит ДО чтения тела запроса (не тратим работу на отказ)', () => {
    const src = read(WRITE_ROUTES[0]!)
    expect(src.indexOf('resolveAdminAccess')).toBeLessThan(src.indexOf('readBody'))
    expect(src.indexOf('isSameOriginWrite')).toBeLessThan(src.indexOf('readBody'))
  })
})
