import { makePortalCall } from './client'
import type { PortalCaller, RestCall } from './provision'
import { saveRefreshedTokens, type IssuingPortal } from '../links/issue'
import { isDeadGrant } from '../domain/portals/lifecycle'
import { markGrantRevoked } from '../portals/store'
import { decryptSecret, encryptSecret } from '../utils/crypto'
import { logger } from '../utils/logger'

/**
 * Turns a stored portal row into a ready-to-use REST call.
 *
 * Вынесено из `server/api/portal/-session.ts`, когда вызывающих стало двое: портальные экраны
 * и воркер доставки ответов. Пока он был один, место было нормальное; со вторым это стало
 * знанием о расшифровке токенов, живущим в обработчике HTTP.
 *
 * ⚠ Домен берётся из записи, то есть из того, что проверили при установке. Это и есть
 * условие, которое `server/b24/client.ts` требует от каждого вызывающего: домен либо
 * из аллоулиста, либо из своей базы, но никогда из запроса.
 *
 * Возвращает `null`, когда токенов нет или они не читаются. Не бросает: у вызывающих разные
 * способы сказать об этом наружу — экран отвечает 503, воркер откладывает задачу.
 */
export function callForPortal(portal: IssuingPortal): PortalCaller | null {
  const accessToken = decryptOrEmpty(portal.accessToken, 'access')
  const refreshToken = decryptOrEmpty(portal.refreshToken, 'refresh')
  if (accessToken === '' || refreshToken === '') {
    logger.error({ domain: portal.domain }, 'у портала нет пригодных токенов')
    return null
  }

  const expiresIn = portal.tokenExpiresAt === null
    ? 0
    : Math.max(0, Math.floor((portal.tokenExpiresAt.getTime() - Date.now()) / 1000))

  const caller = makePortalCall(
    {
      memberId: portal.memberId,
      domain: portal.domain,
      accessToken,
      refreshToken,
      applicationToken: decryptOrEmpty(portal.applicationToken, 'application'),
      expiresIn,
      scope: portal.scopes ?? [],
    },
    // Обновлённые токены сохраняются сразу: SDK меняет их молча, и не записать значит
    // отправить следующий запуск со старой парой, которая после обмена мертва.
    async next => saveRefreshedTokens(portal.id, {
      accessToken: encryptSecret(next.accessToken),
      refreshToken: encryptSecret(next.refreshToken),
      expiresAt: new Date(Date.now() + next.expiresIn * 1000),
      // Шифротекст из строки, а не расшифрованное значение: сравнение идёт с колонкой,
      // а шифрование рандомизировано — второй `encryptSecret` того же токена дал бы
      // другую строку, и условие не совпало бы никогда.
      previousRefreshToken: portal.refreshToken ?? '',
    }),
  )

  // ⚠ Обёртка ставится на ОБА вызова. Мёртвый грант одинаково приезжает и на одиночном
  // методе, и на пакете, а отметка ставится первым отказом — накрыв только один путь,
  // мы бы получили портал, который «не отказывал», пока клиент ходит другой дверью.
  return {
    call: watchGrant(caller.call, portal.id, portal.refreshToken ?? ''),
    batch: watchGrantBatch(caller.batch, portal.id, portal.refreshToken ?? ''),
  }
}

/**
 * Wraps a call so a dead grant is recorded the first time the portal says so.
 *
 * ⚠ ЭТО ЕДИНСТВЕННЫЙ СПОСОБ УЗНАТЬ, что клиент удалил приложение. Событие `ONAPPUNINSTALL`
 * нам недоступно: `application_token` приходит только в событиях, а `ONAPPINSTALL` у тиражного
 * приложения с пунктом в меню не приходит вовсе (проверено на живом портале). Проверять
 * событие удаления нечем даже теоретически — данных авторизации в него не передают.
 * Поэтому об уходе клиента мы узнаём из собственного исходящего вызова: его не подделать
 * снаружи, в отличие от события.
 *
 * ⚠ Обёртка ставится ЗДЕСЬ, в одном месте, а не у каждого вызывающего. Их сейчас двое —
 * портальные экраны и воркер доставки, — и третий забудет. Место выбрано по тому же
 * рассуждению, по которому сюда переехала расшифровка токенов.
 *
 * ⚠ Решение принимается по СТРУКТУРНОМУ коду отказа (`PortalError.code`), а не по тексту.
 * Первая редакция смотрела на результат `safeRefusal`, то есть на строку, в выборе которой
 * участвовал текст портала, — а в тексте портала едет процитированный ответ клиента.
 * Респондент, набравший в анкете `invalid_grant`, объявлял бы грант своего портала мёртвым
 * и запускал отсчёт до стирания токенов. Нашла панель ревью PR #34.
 *
 * Отметка не мешает вызову: ошибка пробрасывается дальше как была, а вызывающие решают
 * сами. Стирание — не здесь: у него месячная отсрочка и уборщик на тике доставки.
 */
function watchGrant(call: RestCall, portalId: string, wentWithRefreshToken: string): RestCall {
  return async (method, params) => {
    try {
      return await call(method, params)
    }
    catch (error) {
      if (isDeadGrant(error)) {
        // Отметка не должна ронять вызов: её неудача — наша беда, а не портала.
        await markGrantRevoked(portalId, new Date(), wentWithRefreshToken).catch(() => {})
      }
      throw error
    }
  }
}

/** То же для пакета: отдельной функцией, потому что у пакета другая форма входа. */
function watchGrantBatch(batch: PortalCaller['batch'], portalId: string, wentWithRefreshToken: string): PortalCaller['batch'] {
  return async (calls) => {
    try {
      return await batch(calls)
    }
    catch (error) {
      if (isDeadGrant(error)) {
        await markGrantRevoked(portalId, new Date(), wentWithRefreshToken).catch(() => {})
      }
      throw error
    }
  }
}

/**
 * Пустая строка вместо исключения: негодный токен обрабатывается выше, одним понятным отказом.
 *
 * ⚠ Неудача расшифровки логируется ОТДЕЛЬНО от «токена не было». Это разные беды: первая
 * означает, что ключ шифрования сменили без `B24_TOKEN_ENC_KEY_OLD`, и тогда «портал
 * не авторизован» приезжает сразу у всех порталов — по общему сообщению это не отличить
 * от единичной поломки. В журнал уходит факт, не содержимое.
 */
function decryptOrEmpty(blob: string | null, field: string): string {
  if (blob === null || blob === '') return ''
  try {
    return decryptSecret(blob)
  }
  catch (error) {
    logger.error({ field, reason: (error as Error).message }, 'токен портала не расшифровался')
    return ''
  }
}
