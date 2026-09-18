import { describe, expect, it } from 'vitest'
import { missingSettings, type ReadinessProbe } from '../../server/utils/readiness'

/**
 * Гвард под дефект первой живой установки.
 *
 * Мастер на тестовом портале показал «Приложение сейчас не может завершить установку.
 * Попробуйте через несколько минут», роут ответил 503 `Not configured`, а в журнале стояла
 * одна строка на четыре возможные причины. Диагноз по ней не ставился: `docker compose`
 * объявляет три переменные через `:?`, то есть пустыми они быть не могут — значит виноват
 * был ключ, который ЗАДАН, но не разворачивается в 32 байта. Отличить это от незаданного
 * `B24_CLIENT_ID` было нечем.
 *
 * Тест держит ровно то, чего тогда не хватило: имя виновника, а не факт «что-то не так».
 */

const READY: ReadinessProbe = {
  clientId: 'local.000',
  clientSecret: 'secret',
  encryptionKeyUsable: true,
  databaseConfigured: true,
}

describe('missingSettings', () => {
  it('на полной конфигурации не называет ничего', () => {
    expect(missingSettings(READY)).toEqual([])
  })

  it('называет ключ шифрования, когда он задан, но не разворачивается в 32 байта', () => {
    // ⚠ Тот самый случай с живого хоста: заглушка вместо `openssl rand -base64 32`.
    // Переменная непустая, поэтому `docker compose` стек поднимает, а установка падает.
    expect(missingSettings({ ...READY, encryptionKeyUsable: false })).toEqual(['B24_TOKEN_ENC_KEY'])
  })

  it('называет пару приложения по отдельности', () => {
    expect(missingSettings({ ...READY, clientId: '' })).toEqual(['B24_CLIENT_ID'])
    expect(missingSettings({ ...READY, clientSecret: '' })).toEqual(['B24_CLIENT_SECRET'])
  })

  it('считает незаданной строку из одних пробелов', () => {
    // `B24_CLIENT_ID= ` в `.env` проходит проверку `:?` в compose и доезжает до нас.
    expect(missingSettings({ ...READY, clientId: '   ' })).toEqual(['B24_CLIENT_ID'])
  })

  it('называет базу', () => {
    expect(missingSettings({ ...READY, databaseConfigured: false })).toEqual(['DATABASE_URL'])
  })

  it('перечисляет всё недостающее разом, сначала правимое руками', () => {
    // Иначе оператор чинит по одной переменной за выкатку, узнавая о следующей из
    // следующего отказа.
    expect(missingSettings({
      clientId: '',
      clientSecret: '',
      encryptionKeyUsable: false,
      databaseConfigured: false,
    })).toEqual(['B24_CLIENT_ID', 'B24_CLIENT_SECRET', 'B24_TOKEN_ENC_KEY', 'DATABASE_URL'])
  })
})
