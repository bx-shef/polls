import { describe, expect, it } from 'vitest'
import { portalHost, readFramePass } from '../../app/utils/frame-auth'

/**
 * Разбор данных фрейма. Файл существует под два конкретных дефекта, и оба прошли мимо
 * компилятора и мимо зелёного `pnpm check`.
 *
 * Первый: код читал `auth.memberId`, а SDK отдаёт `member_id`. У типа `AuthData` объявлена
 * индексная сигнатура `[key: string]: any`, поэтому опечатка компилировалась молча
 * и превращалась в `undefined` во время работы — вкладка в сделке отправляла на сервер
 * пустой идентификатор портала и не заработала бы ни разу.
 *
 * Второй: `auth.domain` — это `getTargetOrigin()`, то есть `https://портал.bitrix24.ru`
 * СО СХЕМОЙ, а наш аллоулист проверяет голый хост. Настоящая установка отбилась бы
 * как поддельная.
 */

/** Ровно то, что возвращает `getAuthData()` — сверено с `dist/esm/frame/auth.mjs`. */
const SDK_SHAPE = {
  access_token: 'фреймовый-токен',
  refresh_token: 'грант-администратора',
  expires: 1789640000,
  expires_in: 3600,
  domain: 'https://shef.bitrix24.ru',
  member_id: 'a223c6b3710f85df22e9377d6c4f7553',
}

describe('пропуск из фрейма', () => {
  it('читает именно те имена полей, которые отдаёт SDK', () => {
    // Гвард под дефект: `member_id`, а не `memberId`. Индексная сигнатура в типе SDK
    // означает, что опечатку здесь не поймает ничто, кроме этого теста.
    const pass = readFramePass(SDK_SHAPE)

    expect(pass).not.toBeNull()
    expect(pass!.memberId).toBe('a223c6b3710f85df22e9377d6c4f7553')
    expect(pass!.authId).toBe('фреймовый-токен')
    expect(pass!.refreshToken).toBe('грант-администратора')
  })

  it('срезает схему с домена портала', () => {
    // Гвард под второй дефект: аллоулист ждёт голый хост, а фрейм даёт полный адрес.
    expect(readFramePass(SDK_SHAPE)!.domain).toBe('shef.bitrix24.ru')
  })

  it('на `false` от фрейма отдаёт null, а не падает', () => {
    // `getAuthData()` возвращает `false`, когда токен протух. Это штатный ответ.
    expect(readFramePass(false)).toBeNull()
    expect(readFramePass(null)).toBeNull()
    expect(readFramePass(undefined)).toBeNull()
  })

  it('без идентификатора портала или токена — не пропуск', () => {
    expect(readFramePass({ ...SDK_SHAPE, member_id: '' })).toBeNull()
    expect(readFramePass({ ...SDK_SHAPE, access_token: '  ' })).toBeNull()
    expect(readFramePass({ ...SDK_SHAPE, member_id: 42 })).toBeNull()
  })

  it('пустой грант — не повод отказать: в обычной работе он не нужен', () => {
    // `refresh_token` нужен только мастеру установки. Вкладка в сделке работает без него,
    // и требовать его здесь значило бы сломать её из-за поля, которое ей не нужно.
    const pass = readFramePass({ ...SDK_SHAPE, refresh_token: '' })

    expect(pass).not.toBeNull()
    expect(pass!.refreshToken).toBe('')
  })
})

describe('хост портала', () => {
  it('принимает обе формы — со схемой и без', () => {
    // Голый хост портал однажды может прислать и сам; лишний разбор ничего не сломает,
    // а отсутствующий — сломает установку целиком.
    expect(portalHost('https://shef.bitrix24.ru')).toBe('shef.bitrix24.ru')
    expect(portalHost('shef.bitrix24.ru')).toBe('shef.bitrix24.ru')
    expect(portalHost('https://shef.bitrix24.ru/')).toBe('shef.bitrix24.ru')
    expect(portalHost('  https://SHEF.bitrix24.ru  ')).toBe('shef.bitrix24.ru')
  })

  it('на мусор отдаёт пустую строку, а не мусор', () => {
    // Пустая строка дальше отсеется аллоулистом как «не домен портала». Пропустить
    // сюда неразобранное значит отдать аллоулисту то, чего он не ждёт.
    expect(portalHost('https://')).toBe('')
    expect(portalHost('')).toBe('')
    expect(portalHost('   ')).toBe('')
  })
})
