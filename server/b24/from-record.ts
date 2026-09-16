import { makePortalCall } from './client'
import type { RestCall } from './provision'
import { saveRefreshedTokens, type IssuingPortal } from '../links/issue'
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
export function callForPortal(portal: IssuingPortal): RestCall | null {
  const accessToken = decryptOrEmpty(portal.accessToken, 'access')
  const refreshToken = decryptOrEmpty(portal.refreshToken, 'refresh')
  if (accessToken === '' || refreshToken === '') {
    logger.error({ domain: portal.domain }, 'у портала нет пригодных токенов')
    return null
  }

  const expiresIn = portal.tokenExpiresAt === null
    ? 0
    : Math.max(0, Math.floor((portal.tokenExpiresAt.getTime() - Date.now()) / 1000))

  return makePortalCall(
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
    }),
  )
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
