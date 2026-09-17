import { eq, sql } from 'drizzle-orm'
import { makePortalCall } from './client'
import { ensureDealTabPlacement, isPortalAdmin, provisionSmartProcesses, readStoredRefs, storeRefs, withDeadline } from './provision'
import { getDb, schema } from '../db/client'
import type { RegisterPortal } from '../domain/portals/install'
import { publicBaseUrl } from '../utils/env'
import { encryptSecret } from '../utils/crypto'
import { logger } from '../utils/logger'

/**
 * Persists a verified portal and provisions it.
 *
 * Вынесено из `server/api/install.post.ts`, когда путей установки стало ДВА: событие
 * `ONAPPINSTALL` и мастер установки во фрейме портала (`app/pages/install.vue`). Разбор
 * входящего у них разный — бракетная форма тела против данных фрейма, — а вот что делать
 * с подтверждённым грантом обязано быть одним куском кода. Порядок «сначала токены, потом
 * обустройство» и перевод в `degraded` при неудаче стоят ровно столько, сколько стоит
 * однажды переставить их местами в одной из двух копий.
 */

/**
 * Бюджет времени на всё обустройство.
 *
 * Холодная установка — 17–19 вызовов подряд под троттлингом SDK, это единицы секунд
 * на здоровом портале. Сорок пять секунд — четырёхкратный запас и при этом заведомо
 * меньше таймаута общего `nginx-proxy`.
 */
const PROVISION_BUDGET_MS = 45_000

/**
 * Записать портал и обустроить его.
 *
 * ⚠ Порядок не переставляется. Токены — то, без чего нельзя вообще ничего, и они пишутся
 * первыми. Смарт-процессы создаются повторно без вреда, а вот второй попытки сохранить
 * токены может не быть: событие установки, скорее всего, не повторяется, а мастер
 * администратор просто закроет.
 */
export async function registerPortal(portal: RegisterPortal): Promise<'ok' | 'degraded'> {
  const now = new Date()
  await getDb()
    .insert(schema.portals)
    .values({
      memberId: portal.memberId,
      domain: portal.domain,
      accessToken: encryptSecret(portal.accessToken),
      refreshToken: encryptSecret(portal.refreshToken),
      applicationToken: encryptSecret(portal.applicationToken),
      tokenExpiresAt: new Date(now.getTime() + portal.expiresInSeconds * 1000),
      scopes: portal.scope,
      status: 'active',
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.portals.memberId,
      // Переустановка на тот же портал — обычное дело: сменилась версия, администратор
      // переставил приложение. Это UPDATE, а не новая запись: иначе к порталу потеряются
      // все привязанные ссылки и буфер.
      set: {
        domain: sql`excluded.domain`,
        accessToken: sql`excluded.access_token`,
        refreshToken: sql`excluded.refresh_token`,
        // Перезаписывается намеренно: при переустановке портал выдаёт новый токен,
        // и сохранённый старый сделал бы непроверяемым каждое следующее событие.
        //
        // ⚠ У мастера установки этого токена НЕТ — фрейм его не отдаёт вовсе. Оттуда сюда
        // приезжает шифротекст пустой строки, и он затирает то, что могло приехать событием
        // раньше. Сегодня это не стоит ничего: подписок на события в проекте нет ни одной.
        // Перед первой подпиской вопрос обязан быть закрыт — см. `readFrameGrant`.
        applicationToken: sql`excluded.application_token`,
        tokenExpiresAt: sql`excluded.token_expires_at`,
        scopes: sql`excluded.scopes`,
        status: sql`excluded.status`,
        updatedAt: sql`excluded.updated_at`,
      },
    })

  logger.info({ domain: portal.domain }, 'токены портала сохранены')

  // Смарт-процессы создаём ПОСЛЕ сохранения токенов и не роняем ими установку.
  // Токены — то, без чего нельзя вообще ничего; смарт-процессы можно создать повторно,
  // а вот второго события установки не будет. Поэтому здесь портал уже установлен,
  // а неудача обустройства переводит его в `degraded`.
  //
  // ⚠ `degraded` сегодня НИКТО не читает: ни проверка здоровья (она про инфраструктуру
  // целиком, не про отдельный портал), ни фоновая задача — её нет. Портал, застрявший
  // в этом статусе, чинится только переустановкой руками. Автоматическое долечивание —
  // отдельная задача, см. `docs/BACKLOG.md`.
  const outcome = await provisionPortal(portal)
  if (outcome !== 'ok') {
    await getDb()
      .update(schema.portals)
      .set({ status: 'degraded', updatedAt: new Date() })
      .where(eq(schema.portals.memberId, portal.memberId))
    logger.warn({ domain: portal.domain, outcome }, 'портал установлен, но не обустроен')
  }

  return outcome === 'ok' ? 'ok' : 'degraded'
}

/**
 * Создать на портале смарт-процессы и поля.
 *
 * Права администратора проверяются ЗДЕСЬ, при установке, а не когда метод понадобится:
 * без них не создать ни смарт-процесс, ни поле, ни записать настройки (`app.option.set`
 * отвечает «Administrator authorization required»). Узнать об этом в момент, когда
 * сотрудник уже ждёт ссылку, — худший из вариантов.
 */
async function provisionPortal(portal: {
  memberId: string
  domain: string
  accessToken: string
  refreshToken: string
  applicationToken: string
  expiresInSeconds: number
  scope: string[]
}): Promise<'ok' | 'not-admin' | 'failed'> {
  const call = makePortalCall(
    {
      memberId: portal.memberId,
      domain: portal.domain,
      accessToken: portal.accessToken,
      refreshToken: portal.refreshToken,
      applicationToken: portal.applicationToken,
      expiresIn: portal.expiresInSeconds,
      scope: portal.scope,
    },
    // SDK обновил токены сам — сохраняем. Только UPDATE: операция идемпотентна
    // при нескольких репликах и не воскресит удалённый портал.
    async (next) => {
      await getDb()
        .update(schema.portals)
        .set({
          accessToken: encryptSecret(next.accessToken),
          refreshToken: encryptSecret(next.refreshToken),
          tokenExpiresAt: new Date(Date.now() + next.expiresIn * 1000),
          updatedAt: new Date(),
        })
        .where(eq(schema.portals.memberId, portal.memberId))
    },
  )

  const budgeted = withDeadline(call, PROVISION_BUDGET_MS)

  try {
    if (!await isPortalAdmin(budgeted)) return 'not-admin'

    const known = await readStoredRefs(budgeted)
    const result = await provisionSmartProcesses(budgeted, known)
    await storeRefs(budgeted, { template: result.template, survey: result.survey })

    if (result.adoptedTemplate || result.adoptedSurvey) {
      // Взяли на портале смарт-процесс, которого не создавали. Обычно это наш же,
      // переживший переустановку, — но отличить его от чужого одноимённого нечем,
      // а поля мы теперь пишем в него. Пусть след останется.
      logger.warn(
        { domain: portal.domain, adopted: [result.adoptedTemplate, result.adoptedSurvey] },
        'смарт-процесс найден по заголовку, а не создан нами',
      )
    }

    // Вкладка регистрируется ПОСЛЕ смарт-процессов и отдельным вызовом: `placement.bind`
    // не кладётся в батч, а вкладка без смарт-процессов показала бы менеджеру пустой экран.
    // Её отказ установку не роняет — без вкладки приложение работает, без токенов нет.
    const placed = await ensureDealTabPlacement(budgeted, publicBaseUrl())
    if (!placed) {
      logger.warn({ domain: portal.domain }, 'вкладка в карточке сделки не зарегистрирована')
    }

    logger.info(
      { domain: portal.domain, created: [result.createdTemplate, result.createdSurvey], addedFields: result.addedFields, placed },
      'смарт-процессы обустроены',
    )
    return 'ok'
  }
  catch (error) {
    logger.error({ domain: portal.domain, reason: (error as Error).message }, 'обустройство портала не удалось')
    return 'failed'
  }
}
