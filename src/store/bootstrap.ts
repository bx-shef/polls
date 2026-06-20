import type { IStore, Queryable } from './types'
import { buildDemo, SURVEY_KEY } from '../demo/seed'

/**
 * Bootstrap прод-стора (ISSUE #6): получить tenant-портал и засеять демо-опрос в пустую БД,
 * чтобы публичный `/s/:key` работал сразу, а реальные сабмиты копились поверх и СОХРАНЯЛИСЬ
 * (в отличие от MemoryStore). Чистые функции над `Queryable`/`IStore` — под pglite-тестами,
 * Nitro-привязка (выбор PgStore по `DATABASE_URL`) — отдельным слоем.
 */

/**
 * member_id локального single-tenant прод-инстанса БЕЗ связки Bitrix (placeholder-портал).
 * Реальные порталы появляются при OAuth-установке (`PortalTokenStore.save`); до связки весь
 * трафик контура A пишется в этот портал. Подчёркивания не коллидируют с настоящими member_id.
 */
export const LOCAL_PORTAL_MEMBER_ID = '__local__'

/**
 * Гарантирует строку `portal` и возвращает её числовой `id` для `PgStoreOptions.portalId`.
 * Идемпотентно (`on conflict (member_id) do nothing`). `tokens` — placeholder `{}` (настоящие
 * OAuth-токены пишет связка портала, #3/#47; до неё токенов нет, но tenant-строка нужна для FK).
 */
export async function ensureDefaultPortal(
  db: Queryable,
  memberId: string = LOCAL_PORTAL_MEMBER_ID,
  domain = 'localhost'
): Promise<number> {
  await db.query(
    `insert into portal (member_id, domain, tokens) values ($1, $2, '{}'::jsonb)
     on conflict (member_id) do nothing`,
    [memberId, domain]
  )
  const r = await db.query<{ id: number }>('select id from portal where member_id = $1 limit 1', [memberId])
  const id = r.rows[0]?.id
  if (id == null) throw new Error('ensureDefaultPortal: не удалось получить id портала')
  return id
}

/**
 * Засеивает демо-опрос в ПУСТОЙ стор (нет текущей версии демо-опроса) — single-tenant MVP до
 * появления админ-флоу создания опросов. Идемпотентно: при наличии версии — no-op (рестарт не
 * плодит дубликаты сидовых ответов). Реальные сабмиты накапливаются поверх и сохраняются.
 */
export async function seedDemoIfEmpty(store: IStore): Promise<boolean> {
  if (await store.currentVersion(SURVEY_KEY)) return false
  await buildDemo(store)
  return true
}
