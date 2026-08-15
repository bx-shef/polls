import { resolveInvitationKeepDays } from '~core/store/pg-invitation'
import { errInfo } from '~core/obs/logger'
import { logger, usePgInvitations } from '../utils/api'

/**
 * Периодическая чистка мёртвых приглашений (#4, #31).
 *
 * **Зачем вообще.** Приглашение несёт СНИМОК CRM-контекста, и `responsibleName` в нём помечен PII.
 * Пока стор был в памяти, вопрос удержания не стоял — перезапуск чистил всё сам. С переездом в БД
 * каждая выписанная ссылка становится строкой с персональными данными, которая иначе лежала бы
 * вечно, в том числе спустя годы после того, как перестала работать.
 *
 * ⚠️ **Отдельный плагин, а не третья работа внутри `keepalive`,** хотя тумбстоуны едут именно там.
 * Причина конкретная: `keepalive` целиком выключается при отсутствии `NUXT_B24_CLIENT_ID/SECRET` —
 * ему без них нечего делать. Для тумбстоунов это безвредно (без кред не бывает установок, а значит и
 * тумбстоунов), а для приглашений — нет: портал мог быть установлен раньше, приглашения выписаны, а
 * креды потом убрать или перепутать. Тогда гейт рефреша токенов молча стал бы гейтом удержания ПДн.
 *
 * ⚠️ Чистка сносит только то, что уже **не может быть использовано**: израсходованное и протухшее
 * старше `INVITATION_KEEP_DAYS` (дефолт 30 суток). Живые приглашения не трогает никогда — иначе
 * ссылка со сроком в 5 дней умирала бы раньше собственного срока.
 *
 * Каденция фиксированная (сутки) и отдельной переменной не заводится: работа — один DELETE по
 * индексу, а лишняя ручка настройки требует объяснения, зачем её крутить. Ответа нет.
 * SERVER-ONLY: `~core/store` импортируется намеренно (Nitro-контур, не в клиентский бандл).
 */
const SWEEP_INTERVAL_MS = 24 * 60 * 60_000
/** Первый прогон с задержкой — дать БД и миграциям подняться на старте (как у keep-alive). */
const FIRST_RUN_DELAY_MS = 30_000

export default defineNitroPlugin((nitroApp) => {
  if (import.meta.prerender) return
  const keepDays = resolveInvitationKeepDays(process.env.INVITATION_KEEP_DAYS)

  const tick = async (): Promise<void> => {
    // В памяти (нет `DATABASE_URL`) чистить нечего: там приглашения и так не переживают перезапуск.
    const store = await usePgInvitations()
    if (!store) return
    const swept = await store.sweepExpired(new Date(), keepDays)
    if (swept > 0) logger.info('invitations_swept', { count: swept, olderThanDays: keepDays })
  }

  const run = (): void => {
    tick().catch((e) => logger.warn('invitation_sweep_fail', { reason: errInfo(e).message }))
  }

  const initial = setTimeout(run, FIRST_RUN_DELAY_MS)
  initial.unref()
  const timer = setInterval(run, SWEEP_INTERVAL_MS)
  timer.unref() // таймер не держит процесс на завершении
  nitroApp.hooks.hook('close', () => {
    clearTimeout(initial)
    clearInterval(timer)
  })
})
