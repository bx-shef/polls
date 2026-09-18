import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { missingForInstall } from '../../server/utils/readiness'

/**
 * Гвард под утверждение о безопасности, которое иначе ничем не держится.
 *
 * В `server/api/health.get.ts` написано: «Наружу уходят ИМЕНА незаданных переменных,
 * но никогда не значения и не длины». Эндпоинт анонимный и открыт в интернет, то есть это
 * утверждение оплачено не удобством, а доверием. Пока оно держалось только типом
 * `RequiredSetting` — закрытым набором из четырёх строк. Тип поймает чужую строку, но не
 * поймает соседнее отладочное поле, которое кто-нибудь допишет рядом с `missing`
 * в теле ответа. Нашла панель ревью PR #28.
 *
 * ⚠ Тест трогает `process.env` и потому обязан прибирать за собой: соседние тесты в этом
 * же процессе читают те же переменные.
 */

const TOUCHED = ['B24_CLIENT_ID', 'B24_CLIENT_SECRET', 'B24_TOKEN_ENC_KEY'] as const
const saved = new Map<string, string | undefined>()

/** Пустая строка вместо удаления: `delete` по вычисляемому ключу запрещён линтом, а для
 *  всех трёх переменных «пусто» и «не задано» — одно и то же состояние. */
function set(name: string, value: string) {
  if (!saved.has(name)) saved.set(name, process.env[name])
  process.env[name] = value
}

afterEach(() => {
  for (const [name, value] of saved) process.env[name] = value ?? ''
  saved.clear()
})

describe('готовность к установке наружу', () => {
  it('не выносит наружу ни значения переменных, ни их длины', () => {
    const secret = 'очень-секретное-значение-которого-не-должно-быть-в-ответе'
    for (const name of TOUCHED) set(name, secret)

    const serialized = JSON.stringify({ install: { missing: missingForInstall() } })

    expect(serialized).not.toContain(secret)
    // Длина тоже не уезжает: она сужает перебор ключа.
    expect(serialized).not.toContain(String(secret.length))
  })

  it('отдаёт только имена из закрытого набора', () => {
    for (const name of TOUCHED) set(name, '')

    // Список записан здесь ОТДЕЛЬНО и вручную, а не выведен из типа: взятый из типа,
    // он расширялся бы вместе с ним и остался бы зелёным на любом новом поле.
    const allowed = ['B24_CLIENT_ID', 'B24_CLIENT_SECRET', 'B24_TOKEN_ENC_KEY', 'DATABASE_URL']
    for (const name of missingForInstall()) expect(allowed).toContain(name)
  })

  it('называет ключ шифрования, когда он задан заглушкой не на 32 байта', () => {
    // Тот самый случай с живого хоста: `docker compose` объявляет переменную через `:?`,
    // поэтому пустой она быть не может — а негодной может.
    set('B24_CLIENT_ID', 'local.000')
    set('B24_CLIENT_SECRET', 'секрет')
    set('B24_TOKEN_ENC_KEY', 'подставь-сюда-настоящий-ключ')

    expect(missingForInstall()).toContain('B24_TOKEN_ENC_KEY')
  })

  it('считает незаданной пару приложения из одних пробелов', () => {
    // ⚠ `B24_CLIENT_ID= ` в `.env` проходит проверку `:?` в compose и доезжает сюда.
    // Проверка и потребитель обязаны видеть одну строку: `server/utils/env.ts` обрезает
    // пробелы, иначе установка отвечала бы «вы не администратор» на кривой секрет.
    set('B24_CLIENT_ID', '   ')
    set('B24_CLIENT_SECRET', '\n')

    expect(missingForInstall()).toContain('B24_CLIENT_ID')
    expect(missingForInstall()).toContain('B24_CLIENT_SECRET')
  })
})
