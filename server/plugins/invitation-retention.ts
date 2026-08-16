import { SWEEP_BATCH, resolveInvitationKeepDays } from '~core/store/pg-invitation'
import { errInfo } from '~core/obs/logger'
import { logger, usePgInvitations } from '../utils/api'

/**
 * Периодическая чистка мёртвых приглашений (#4, #31).
 *
 * **Зачем вообще.** Приглашение несёт СНИМОК CRM-контекста: `responsibleName` (ФИО сотрудника,
 * помечен PII в схеме), `companyName`, названия товаров в `products[]`, плюс денормализованные
 * `contact_id`/`company_id`/`responsible_id` отдельными колонками. Пока стор был в памяти, вопрос
 * удержания не стоял — перезапуск чистил всё сам. С переездом в БД каждая выписанная ссылка
 * становится строкой с персональными данными, которая иначе лежала бы вечно, в том числе спустя
 * годы после того, как перестала работать.
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
 * ⚠️ **Скоуп — один портал** (`usePgInvitations()` строит стор на портале по умолчанию). Сегодня это
 * весь мир: single-tenant, один портал на инстанс. С приходом мультитенанта (#47/#49) приглашения
 * остальных порталов не подметёт НИКТО, и заметить это будет неоткуда — гейт молчит, когда чистить
 * нечего. Инвариант записан здесь, чтобы обход порталов не забыли завести вместе с ними.
 *
 * Каденция фиксированная (сутки) и отдельной переменной не заводится: лишняя ручка настройки
 * требует объяснения, зачем её крутить, а ответа нет. Сам DELETE идёт полным сканом `invitation`
 * (предикат — ИЛИ по двум разным колонкам, одним btree его не обслужить) и это осознанно: таблица
 * мала, прогон суточный, а дорогой в нём была не выборка, а проверка FK со стороны `response` — под
 * неё в `0005` заведён индекс.
 * SERVER-ONLY: `~core/store` импортируется намеренно (Nitro-контур, не в клиентский бандл).
 */
const SWEEP_INTERVAL_MS = 24 * 60 * 60_000
/** Сколько батчей разбирать за один прогон (кап на случай большого накопленного хвоста). */
const MAX_PASSES = 20
/** Первый прогон с задержкой — дать БД и миграциям подняться на старте (как у keep-alive). */
const FIRST_RUN_DELAY_MS = 30_000

export default defineNitroPlugin((nitroApp) => {
  if (import.meta.prerender) return
  const keepDays = resolveInvitationKeepDays(process.env.INVITATION_KEEP_DAYS)

  const tick = async (): Promise<void> => {
    // В памяти (нет `DATABASE_URL`) чистить нечего: там приглашения и так не переживают перезапуск.
    const store = await usePgInvitations()
    if (!store) return
    // ⚠️ Несколько батчей за прогон, а не один. Каждый DELETE ограничен капом, чтобы не держать
    // соединение пула на всём накопленном хвосте; но и растягивать разбор хвоста на месяцы по
    // батчу в сутки незачем. Останавливаемся, как только батч вернул меньше капа, — хвост кончился.
    let swept = 0
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const n = await store.sweepExpired(new Date(), keepDays)
      swept += n
      if (n < SWEEP_BATCH) break
    }
    if (swept > 0) logger.info('invitations_swept', { count: swept, olderThanDays: keepDays })
  }

  const run = (): void => {
    tick().catch((e) => logger.warn('invitation_sweep_fail', { reason: errInfo(e).message }))
  }

  // Видимый след при старте: иначе владелец не может подтвердить, что удержание ПДн включено и с
  // каким сроком. У соседнего keep-alive такой след есть (`keepalive_on`), и его тут не хватало.
  logger.info('invitation_retention_on', { keepDays, intervalHours: SWEEP_INTERVAL_MS / 3_600_000 })

  const initial = setTimeout(run, FIRST_RUN_DELAY_MS)
  initial.unref()
  const timer = setInterval(run, SWEEP_INTERVAL_MS)
  timer.unref() // таймер не держит процесс на завершении
  nitroApp.hooks.hook('close', () => {
    clearTimeout(initial)
    clearInterval(timer)
  })
})
