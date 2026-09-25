import { defineEventHandler } from 'h3'
import { provisionWithCall } from '../../b24/register'
import { applyProvisionStatus } from '../../portals/store'
import { logger } from '../../utils/logger'
import { openPortalSession } from './-session'

/**
 * Re-runs provisioning on an already installed portal, using the tokens we stored.
 *
 * ⚠ Существует потому, что у состояния «токены сохранены, смарт-процессы нет» не было
 * выхода. Мастер установки (`app/pages/install.vue`) предлагал «попробовать ещё раз», а это
 * означало повторный обмен гранта — и обмен ВРАЩАЕТ грант: присланный `refresh_token` после
 * первой удачной попытки мёртв. Второе нажатие гарантированно получало отказ сервера
 * авторизации и показывало человеку «вы не администратор» — сообщение, не имеющее никакого
 * отношения к причине. Единственным настоящим выходом была переустановка приложения целиком,
 * и интерфейс об этом не говорил. Нашла панель ревью PR #27.
 *
 * Здесь обмена нет вовсе: токены уже наши, их достаточно. Пропуск проверяется так же, как
 * на всех портальных экранах (`openPortalSession`), а права администратора спрашиваются
 * внутри обустройства — без них смарт-процессы всё равно не создать.
 *
 * Идемпотентно: смарт-процессы ищутся перед созданием, поля добавляются только недостающие.
 */
export default defineEventHandler(async (event) => {
  const session = await openPortalSession(event)

  const outcome = await provisionWithCall(session.call, session.portal.domain)
  // ⚠ Исход ЗАПИСЫВАЕТСЯ, и до разбора issue #12 этого здесь не было: кнопка чинила портал
  // и оставляла его помеченным `degraded` навсегда. Заметить это было нечем — статус
  // до появления долечивания не перечитывала ни одна строка кода.
  await applyProvisionStatus(session.portal.id, outcome)
  logger.info({ domain: session.portal.domain, outcome }, 'портал доустроен')

  // Три исхода вместо двух: «не администратор» отличается от «не получилось», потому что
  // лечится по-разному — позвать администратора против попробовать позже.
  return { ok: outcome === 'ok', reason: outcome }
})
