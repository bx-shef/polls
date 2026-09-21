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
import { sql } from 'drizzle-orm'

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
   *
   * ⚠ Заполнение этой колонки ПОЗЖЕ установки обязано перерегистрировать вкладку в карточке
   * сделки: её обработчик прописан в портал при установке, когда этого хоста ещё не было,
   * и сам он не обновится. Иначе ссылки поедут с нового хоста, а вкладка останется на старом —
   * и половина приложения будет жить по одному адресу, половина по другому.
   */
  publicHost: text('public_host'),
  /** Шифротекст; ключ живёт в окружении, в логи не попадает никогда. */
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  /**
   * Постоянный токен приложения из события установки. Тоже шифротекст.
   * По нему сверяется каждое последующее событие портала: без него обработчик событий
   * принимает что угодно от кого угодно, а адрес обработчика доступен из интернета.
   */
  applicationToken: text('application_token'),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
  scopes: text('scopes').array(),
  license: text('license'),
  /** active | degraded | deleted — портал удалил приложение, долбиться в него больше нельзя. */
  status: text('status').notNull().default('active'),
  /**
   * Когда портал ВПЕРВЫЕ отказал по мёртвому гранту. `null` — не отказывал.
   *
   * ⚠ Существует потому, что событие удаления приложения до нас не доходит. У тиражного
   * приложения с пунктом в меню `ONAPPINSTALL` после `installFinish()` не приходит вовсе
   * (проверено на живом портале), а `application_token` приходит только в событиях — значит
   * `ONAPPUNINSTALL` проверить нечем даже теоретически: данных авторизации в него не передают.
   * Без этой колонки токены ушедшего клиента лежали бы у нас вечно.
   *
   * ⚠ Отметка ставится ОДИН раз, первым отказом, и снимается первым успехом. Переписывать её
   * на каждом отказе значит отодвигать срок вечно: уборщик выглядел бы рабочим и не работал.
   * Приём взят у `client-bank-alfa-by` (`grant_revoked_at`), где оплачен живыми клиентами.
   */
  grantRevokedAt: timestamp('grant_revoked_at', { withTimezone: true }),
  installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('portals_member_id_key').on(table.memberId),
  // ⚠ Под уборщик мёртвых грантов: он ходит сюда каждую минуту с
  // `WHERE grant_revoked_at < граница ORDER BY grant_revoked_at`. Комментарий в плагине
  // обещал «один индексный запрос», а индекса не было вовсе — то есть последовательный
  // проход по всей таблице с сортировкой, вечно. Сегодня это ничего не стоит, но обещание
  // в комментарии было ложным, и первый, кто оценит цену по нему, ошибётся.
  // Частичный: помеченных порталов всегда единицы, а строк в таблице — все клиенты.
  index('portals_grant_revoked_idx')
    .on(table.grantRevokedAt)
    .where(sql`${table.grantRevokedAt} is not null`),
])

/** Буфер входящих ответов: сохраняем до того, как пробуем записать в портал. */
export const inbox = pgTable('inbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  portalId: uuid('portal_id').notNull().references(() => portals.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  payload: jsonb('payload').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  /**
   * pending | sending | failed. Запись УДАЛЯЕТСЯ после подтверждённой записи в портал,
   * поэтому состояния «доставлено» тут нет: доставленного ответа у нас не остаётся.
   *
   * `sending` — строку взял воркер. Умер между «взял» и «доставил» — её вернёт `requeueStuck`,
   * иначе один перезапуск в неудачный момент тихо теряет ответ.
   */
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  /**
   * Не раньше этого момента пробовать снова.
   *
   * Отдельная колонка, а не вычисление из `attempts` и `received_at`: иначе выборка
   * «что пора доставить» превращается в арифметику внутри WHERE, которую не накроет индекс,
   * и на первой же тысяче отложенных строк разбор буфера начнёт читать таблицу целиком.
   */
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('inbox_status_received_idx').on(table.status, table.receivedAt),
  // Индекс ровно под выборку воркера: «pending, чей срок подошёл, в порядке поступления».
  index('inbox_due_idx').on(table.status, table.nextAttemptAt),
])

/**
 * Соответствие «хеш токена → элемент смарт-процесса».
 *
 * В хранилище только хеш, никогда сам токен: предсказуемая ссылка — это чужая анкета перебором,
 * а хеш подобрать нельзя. Сам токен существует ровно в одном месте — в выданном URL, у человека
 * в мессенджере.
 *
 * ⚠ ЭТО НЕ КЭШ, хотя таблица долго называлась кэшем и в этом комментарии стояло
 * «теряется — восстанавливается из портала». Восстановить её НЕЧЕМ: хеша токена нет ни в одном
 * поле смарт-процесса «Опрос» (см. `SURVEY_FIELDS`), а вывести его из элемента нельзя — на то
 * он и хеш. Потеряв том с базой, мы гасим все выданные и ещё не пройденные ссылки навсегда:
 * менеджер сможет выпустить новую, но URL, уже ушедший клиенту, откроется как несуществующий.
 *
 * Соседний `survey_templates` — настоящий кэш: схему версии всегда можно перечитать из портала
 * по паре «код + версия». Здесь такой пары нет. Разница в цене восстановления, и путать их
 * нельзя: слово «кэш» означает «терять не страшно», а терять как раз страшно.
 *
 * Практически это значит, что `db-data` подлежит резервному копированию наравне с токенами
 * порталов, а не наравне с кэшем. Заведено отдельным issue; здесь записано, чтобы через полгода
 * это не выглядело решением, которое кто-то принимал.
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
  /**
   * Версия шаблона на момент выпуска ссылки.
   * Без неё показать анкету нельзя: опубликованная версия неизменяема, а вот КАКАЯ именно
   * версия была отправлена этому человеку — знает только ссылка. Через полгода по коду
   * без версии нашлась бы третья редакция вопросов, и ответ лёг бы не к тем формулировкам.
   */
  surveyVersion: integer('survey_version').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  /** created | sent | opened | completed | revoked | expired. */
  status: text('status').notNull().default('created'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('link_index_token_hash_key').on(table.tokenHash),
  index('link_index_expires_idx').on(table.expiresAt),
])

/**
 * Кэш опубликованных версий шаблона опроса.
 *
 * Это кэш в том же смысле, что и `link_index`: источник истины — смарт-процесс «Шаблон опроса»
 * на портале, а здесь копия, которую можно выбросить и собрать заново. Держать её обязательно
 * по двум причинам, и обе из правил проекта.
 *
 * Первая: публичная страница анкеты не знает о REST вообще — это инвариант, а не оптимизация.
 * Ходить за шаблоном в портал на каждый показ значит поселить знание о портале ровно там,
 * где его не должно быть, и заодно посадить страницу постороннего человека на доступность
 * чужого API.
 *
 * Вторая: версия неизменяема по инварианту («Опубликованная версия опроса неизменяема;
 * правка порождает новую»), поэтому кэш по паре «код + версия» не может протухнуть — он может
 * только отсутствовать. Заполняется при выпуске ссылки, то есть заведомо раньше, чем
 * понадобится.
 */
export const surveyTemplates = pgTable('survey_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  portalId: uuid('portal_id').notNull().references(() => portals.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  version: integer('version').notNull(),
  /** Схема анкеты целиком: секции, вопросы, веса, шкалы, диапазоны интерпретации. */
  schema: jsonb('schema').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex('survey_templates_portal_code_version_key').on(table.portalId, table.code, table.version),
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
