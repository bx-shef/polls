import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Минимальная своя схема (`docs/PROCESS.md`, раздел 5). Источник истины — портал;
 * у нас только то, без чего работать нечем: токены, буфер доставки, кэш-индекс ссылок
 * и последняя известная стадия сущностей. Ни одного поля с ответом клиента, живущего
 * дольше, чем нужно для доставки.
 */

/** Порталы, на которые установлено приложение. */
export const portals = pgTable('portals', {
  id: uuid('id').primaryKey().defaultRandom(),
  memberId: text('member_id').notNull(),
  domain: text('domain').notNull(),
  /**
   * Публичный хост, от которого строится ссылка на анкету.
   * Отдельное поле, а не глобальная константа: домен клиента — предмет договорённости,
   * и переписывать генерацию ссылок после релиза дороже, чем завести колонку сейчас.
   * Пусто — берём `PUBLIC_BASE_URL`.
   */
  publicHost: text('public_host'),
  /** Шифротекст; ключ живёт в окружении, в логи не попадает никогда. */
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
  scopes: text('scopes').array(),
  license: text('license'),
  /** active | degraded | deleted — портал удалил приложение, долбиться в него больше нельзя. */
  status: text('status').notNull().default('active'),
  installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('portals_member_id_key').on(table.memberId),
])

/** Буфер входящих ответов: сохраняем до того, как пробуем записать в портал. */
export const inbox = pgTable('inbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  portalId: uuid('portal_id').notNull().references(() => portals.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  payload: jsonb('payload').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  /** pending | delivered | failed. Запись удаляется после подтверждённой записи в портал. */
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
}, table => [
  index('inbox_status_received_idx').on(table.status, table.receivedAt),
])

/** Исходящие записи в портал: идемпотентны по `dedup_key`. */
export const outbox = pgTable('outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  portalId: uuid('portal_id').notNull().references(() => portals.id, { onDelete: 'cascade' }),
  /** Что именно пишем: элемент смарт-процесса, комментарий в таймлайн, поле сущности. */
  kind: text('kind').notNull(),
  payload: jsonb('payload').notNull(),
  dedupKey: text('dedup_key').notNull(),
  /** pending | done | dead — исчерпал попытки и уехал в отчёт о здоровье, а не потерялся. */
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('outbox_portal_dedup_key').on(table.portalId, table.dedupKey),
  index('outbox_status_created_idx').on(table.status, table.createdAt),
])

/**
 * Кэш «хеш токена → элемент смарт-процесса».
 * Это кэш: теряется — восстанавливается из портала. В хранилище только хеш, никогда сам токен.
 */
export const linkIndex = pgTable('link_index', {
  id: uuid('id').primaryKey().defaultRandom(),
  portalId: uuid('portal_id').notNull().references(() => portals.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  // bigint, а не integer: идентификаторы элементов смарт-процессов выдаёт портал,
  // а не мы, и запас тут дешевле, чем миграция типа на живых данных. `mode: 'number'`
  // безопасен, пока значения не перешагнули 2^53 — для идентификаторов CRM это не сценарий.
  itemId: bigint('item_id', { mode: 'number' }).notNull(),
  surveyCode: text('survey_code').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  /** created | sent | opened | completed | revoked | expired. */
  status: text('status').notNull().default('created'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('link_index_token_hash_key').on(table.tokenHash),
  index('link_index_expires_idx').on(table.expiresAt),
])

/**
 * Последняя известная стадия сущности.
 * Отдельного события «стадия изменилась» в Битрикс24 нет — разницу считаем сами,
 * сравнивая с этим снимком.
 */
export const stageCache = pgTable('stage_cache', {
  portalId: uuid('portal_id').notNull().references(() => portals.id, { onDelete: 'cascade' }),
  entityType: text('entity_type').notNull(),
  entityId: bigint('entity_id', { mode: 'number' }).notNull(),
  lastStage: text('last_stage').notNull(),
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  primaryKey({ columns: [table.portalId, table.entityType, table.entityId] }),
])
