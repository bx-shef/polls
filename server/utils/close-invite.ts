// Закрытие дела-приглашения при получении ответа (#177) — Nitro-слой: ядро про REST не знает.
//
// Зачем это вообще. Дело в таймлайне сделки — призыв к действию «Отправить приглашение», и до сих
// пор его никто не закрывал: `COMPLETED: Y` не ставился нигде. Два следствия, и оба заметны.
//  1. **Продуктовое.** В карточке сделки навсегда висела незакрытая задача — в том числе после того,
//     как клиент уже ответил. Менеджер видит вечный таск, служба качества — растущий список
//     фантомных дел, и доверие к блоку падает быстрее, чем приезжает остальная часть #18.
//  2. **Инженерное.** Две нижние строки правила «уже приглашали?» («дело закрыто, ответа нет» и
//     «дело закрыто, ответ есть») были НЕДОСТИЖИМЫ: открытое дело перевешивает всё, поэтому на любой
//     повторный переход правило отвечало «ждём клиента» — даже когда клиент давно ответил.
import { Bitrix24OAuth } from '~core/bitrix24/oauth'
import { createPortalClient, frameToB24Params } from '~core/bitrix24/client'
import { completeActivity, openInviteActivities } from '~core/bitrix24/activity'
import { resolveInstalledMemberId } from '~core/bitrix24/portal'
import type { AnsweredInfo } from '~core/api/handlers'
import { usePortalDb, logger } from './api'
import { usePortalTokenStore, b24AppConfig } from './portal'
import { timeoutFetch } from './b24-fetch'

/**
 * Закрыть открытые дела-приглашения по сделке и опросу из ответа.
 *
 * ⚠️ Best-effort по построению: **ответ клиента дороже отметки в таймлайне**. Всё, чего может не
 * быть (портал не установлен, нет БД, нет конфигурации, сделки нет в снимке), — штатный выход без
 * шума; настоящий отказ портала логируется, но наружу не идёт. Заставить человека заполнять анкету
 * заново из-за недоступности CRM — худшее, что тут можно сделать.
 *
 * ⚠️ Дел может быть НЕСКОЛЬКО: сделка может пройти триггерную стадию не один раз, и на каждый заход
 * выписывается своё приглашение. Ответ закрывает вопрос по опросу целиком, поэтому закрываем все
 * открытые — иначе оставшееся дело так и висело бы призывом отправить ссылку уже ответившему клиенту.
 */
export async function closeInviteActivities(info: AnsweredInfo): Promise<void> {
  const dealId = info.context.dealId
  if (dealId === undefined) return // публичная ссылка без привязки к сделке — закрывать нечего

  const db = await usePortalDb()
  if (!db) return // режим памяти (dev/демо): портала нет вовсе
  const cfg = b24AppConfig()
  const tokenStore = await usePortalTokenStore()
  if (!cfg || !tokenStore) return // интеграция не сконфигурирована

  const memberId = await resolveInstalledMemberId(db)
  if (!memberId) return // приложение ещё не установлено — сервис работает сам по себе

  try {
    const oauth = new Bitrix24OAuth({
      clientId: cfg.secret.clientId,
      clientSecret: cfg.secret.clientSecret,
      fetch: timeoutFetch
    })
    const tokens = await tokenStore.load(memberId)
    const accessToken = await tokenStore.accessToken(memberId, oauth)
    if (!tokens?.domain || !accessToken) return
    const client = createPortalClient(
      frameToB24Params({ domain: tokens.domain, accessToken, memberId }),
      cfg.secret
    )
    const ids = await openInviteActivities(client, dealId, info.surveyKey)
    for (const id of ids) await completeActivity(client, id)
    // Ноль тоже пишем: «дел не было» и «дела были и закрыты» — разные факты, и на живом прогоне
    // отличить их надо будет по логу, а не по догадке.
    logger.info('b24_invite_closed', { surveyKey: info.surveyKey, dealId, closed: ids.length })
  } catch (e) {
    // Отметка не поставлена — дело останется висеть, и правило «уже приглашали?» на следующем
    // переходе ответит «ждём клиента». Неприятно, но ответ записан, а это главное.
    logger.warn('b24_invite_close_fail', {
      surveyKey: info.surveyKey, dealId, detail: (e as Error).message
    })
  }
}
