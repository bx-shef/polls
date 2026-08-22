import { LOCAL_PORTAL_MEMBER_ID, type IStore, type Queryable } from './types'
import { buildDemo, SURVEY_KEY } from '../demo/seed'

/**
 * Bootstrap прод-стора (ISSUE #6): получить портал ПО УМОЛЧАНИЮ и засеять демо-опрос в пустую БД,
 * чтобы публичный `/s/:key` работал сразу, а реальные сабмиты копились поверх и СОХРАНЯЛИСЬ
 * (в отличие от MemoryStore). Чистые функции над `Queryable`/`IStore` — под pglite-тестами,
 * Nitro-привязка (выбор PgStore по `DATABASE_URL`) — отдельным слоем.
 */

/**
 * member_id локального прод-инстанса БЕЗ связки Bitrix (placeholder-портал).
 * Реальные порталы появляются при OAuth-установке (`PortalTokenStore.save`); до связки весь
 * трафик контура A пишется в этот портал.
 *
 * Ре-экспорт: сама константа живёт в `store/types`, чтобы её мог читать и слой `bitrix24`, не
 * притягивая сюда бутстрап с демо-датасетом.
 */
export { LOCAL_PORTAL_MEMBER_ID } from './types'

/**
 * Числовой `id` портала ПО УМОЛЧАНИЮ (`PgStoreOptions.portalId` фолбэк-стора).
 *
 * ⚠️ Это НЕ «портал инстанса» — с мультитенанта (#47/#49) портал приходит параметром запроса
 * (`storeFor`/`invitationsFor`/`useApiFor`), а сюда попадают только пути, где портала нет ВООБЩЕ:
 * режим памяти (dev/демо без `DATABASE_URL`), dev-открытый дашборд/админка и ключ опроса, которого
 * не публиковал никто. Тем не менее строка нужна: `survey_group.portal_id` — внешний ключ, и без
 * портала засев демо-опроса не вставился бы вовсе.
 *
 * ⚠️ Фолбэк — ВСЕГДА плейсхолдер `__local__`, даже когда настоящие порталы в базе есть (решение
 * владельца 2026-08-22, вместе со снятием присвоения). Прежнее правило «настоящий портал
 * приоритетнее» обслуживало присвоение: после переименования строки `__local__` в базе не
 * оставалось, и фолбэк обязан был найти настоящую. Без присвоения оно превращалось в дыру наоборот —
 * после первого же рестарта фолбэком становился ЧЕЙ-ТО боевой тенант: автономные записи уезжали бы
 * в данные клиента, а засев демо блокировался навсегда. Тенант клиента фолбэком быть не может ни
 * при каком раскладе; настоящие порталы этот выбор не касается вовсе — их резолвят
 * `storeFor`/`portalIdByMemberId` по запросу (#47/#49).
 *
 * `tokens` у плейсхолдера — `{}` (настоящие OAuth-токены пишет связка портала, #3/#47; до неё
 * токенов нет, но tenant-строка нужна для FK).
 */
export async function ensureDefaultPortal(
  db: Queryable,
  opts: {
    /** `member_id` плейсхолдера (тесты/ручные сценарии). Default: `__local__`. */
    memberId?: string
    domain?: string
  } = {}
): Promise<number> {
  const placeholder = opts.memberId ?? LOCAL_PORTAL_MEMBER_ID
  const pick = async (): Promise<number | undefined> => {
    const r = await db.query<{ id: number }>(
      'select id from portal where member_id = $1', [placeholder]
    )
    return r.rows[0]?.id
  }

  const found = await pick()
  if (found !== undefined) return found
  await db.query(
    `insert into portal (member_id, domain, tokens) values ($1, $2, '{}'::jsonb)
     on conflict (member_id) do nothing`,
    [placeholder, opts.domain ?? 'localhost']
  )
  // `on conflict do nothing`: гонка двух инстансов (rolling-обновление watchtower) второй строки не
  // даёт — перечитываем id победителя.
  const after = await pick()
  if (after === undefined) throw new Error('ensureDefaultPortal: не удалось получить id портала')
  return after
}

/**
 * Портал по этому id — ПЛЕЙСХОЛДЕР (служебная строка автономных данных)?
 *
 * ⚠️ Ответ решает, можно ли сеять демо-данные. С фолбэком «всегда плейсхолдер»
 * ({@link ensureDefaultPortal}) гейт при штатном старте истинен всегда — он остаётся СТРАХОВКОЙ от
 * регресса выбора фолбэка: демо в чужой боевой тенант нельзя ни при каком раскладе, и это условие
 * обязано проверяться у самой точки засева, а не выводиться из соседнего модуля.
 */
export async function isPlaceholderPortal(
  db: Queryable,
  portalId: number,
  memberId: string = LOCAL_PORTAL_MEMBER_ID
): Promise<boolean> {
  const r = await db.query<{ member_id: string }>('select member_id from portal where id = $1', [portalId])
  return r.rows[0]?.member_id === memberId
}

/**
 * Засеивает демо-опрос в ПУСТОЙ стор (нет текущей версии демо-опроса) — чтобы публичный `/s/:key`
 * работал сразу после развёртывания, до первой публикации в админке. Идемпотентно: при наличии
 * версии — no-op (рестарт не плодит дубликаты сидовых ответов).
 *
 * ⚠️ **Зовётся ТОЛЬКО когда портал по умолчанию — плейсхолдер** (гейт у вызывающего,
 * {@link isPlaceholderPortal}). С фолбэком «всегда плейсхолдер» это условие при штатном старте
 * истинно всегда, но гейт НЕ снимается — он страхует ровно от регресса выбора фолбэка: окажись
 * порталом по умолчанию чей-то боевой тенант, boot опубликовал бы ему две версии анкеты и дюжину
 * выдуманных ответов с чужими названиями компаний и ФИО ответственных. Дальше это уже не косметика:
 * ключ демо совпадает с `DEFAULT_SURVEY_KEY`, по которому виджет и робот выписывают приглашения, —
 * реальному клиенту ушла бы ссылка на демо-анкету, а дашборд смешал бы выдуманные ответы с
 * настоящими. Ни ошибки, ни отличия от нормы — только `store_seeded` в логе.
 *
 * ⚠️ Присвоение плейсхолдера установкой СНЯТО (решение владельца 2026-08-22): демо-данные навсегда
 * остаются данными плейсхолдера, ни один установившийся портал их не получает. Прежний остаток
 * «первый арендатор получает демо-опрос в свои данные» закрыт этим же снятием.
 */
export async function seedDemoIfEmpty(store: IStore): Promise<boolean> {
  if (await store.currentVersion(SURVEY_KEY)) return false
  await buildDemo(store)
  return true
}
