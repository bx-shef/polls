import { LOCAL_PORTAL_MEMBER_ID, type IStore, type Queryable } from './types'
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
 * трафик контура A пишется в этот портал.
 *
 * Ре-экспорт: сама константа живёт в `store/types`, чтобы её мог читать и слой `bitrix24`, не
 * притягивая сюда бутстрап с демо-датасетом.
 */
export { LOCAL_PORTAL_MEMBER_ID } from './types'

/**
 * Возвращает числовой `id` портала, под которым работает инстанс (`PgStoreOptions.portalId`).
 *
 * Правило single-tenant: **портал ровно один**, поэтому
 *  - есть НАСТОЯЩИЙ (установленный) портал → берём его;
 *  - есть только плейсхолдер → берём его;
 *  - строк нет → заводим плейсхолдер `__local__` и берём его.
 *
 * ⚠️ «Настоящий приоритетнее плейсхолдера», а не «самый ранний». Разница видна в реальном жизненном
 * цикле: обычное удаление приложения идёт с `CLEAN=0`, то есть строка портала ОСТАЁТСЯ. Тестовый
 * портал поставили и удалили без очистки → рядом с ним плейсхолдер → ставят боевой портал. По правилу
 * «самый ранний» инстанс писал бы под плейсхолдер (он старше), удаление боевого портала чистило бы
 * пустую строку, и #171 вернулся бы — только теперь его не лечит ни рестарт, ни переустановка.
 *
 * ⚠️ «Берём существующую, а не ищем по `member_id`» — не мелочь ([#171](https://github.com/bx-shef/polls/issues/171)).
 * При установке плейсхолдер ПЕРЕИМЕНОВЫВАЕТСЯ в настоящий `member_id` (`SaveTokensOpts.adoptLocal`),
 * и если бы старт по-прежнему искал строго `__local__`, следующий же рестарт завёл бы ВТОРОЙ,
 * пустой портал и начал писать туда. Данные снова разъехались бы с установленным порталом — то
 * есть удаление приложения снова перестало бы стирать ПДн, но теперь ещё и после каждого рестарта.
 *
 * ⚠️ НАСТОЯЩИХ порталов больше одного — состояние вне поддержки single-tenant
 * ([#49](https://github.com/bx-shef/polls/issues/49)). Берём самый ранний (детерминированно) и
 * сообщаем наружу через `onAmbiguous` СПИСКОМ member_id: молчаливый выбор означал бы, что часть
 * данных пишется не тому порталу и никто об этом не узнает, а одно число в логе не даёт понять, кого
 * с кем спутали.
 *
 * ⚠️ **Эта функция и `SaveTokensOpts.adoptLocal` подлежат УДАЛЕНИЮ при переходе на мультитенант**
 * ([#49](https://github.com/bx-shef/polls/issues/49)): там стор скоупится порталом события, а не
 * выбирается на процесс. Оставленные «как есть» они не упадут, а тихо деградируют — прибьют инстанс
 * к одному тенанту.
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
    /** Настоящих порталов больше одного: сообщить, какой выбран и кто ещё есть. */
    onAmbiguous?: (chosen: string, all: readonly string[]) => void
  } = {}
): Promise<number> {
  const placeholder = opts.memberId ?? LOCAL_PORTAL_MEMBER_ID
  const pick = async (): Promise<{ id: number; member_id: string } | undefined> => {
    // Сортировка: сначала НАСТОЯЩИЕ порталы, потом плейсхолдер; внутри группы — по id.
    const r = await db.query<{ id: number; member_id: string }>(
      'select id, member_id from portal order by (member_id = $1) asc, id asc',
      [placeholder]
    )
    const real = r.rows.filter((x) => x.member_id !== placeholder)
    if (real.length > 1) opts.onAmbiguous?.(real[0]!.member_id, real.map((x) => x.member_id))
    return r.rows[0]
  }

  const found = await pick()
  if (found) return found.id
  await db.query(
    `insert into portal (member_id, domain, tokens) values ($1, $2, '{}'::jsonb)
     on conflict (member_id) do nothing`,
    [placeholder, opts.domain ?? 'localhost']
  )
  // ⚠️ ПЕРЕЧИТЫВАЕМ тем же правилом, а не по `member_id` плейсхолдера. Между первым чтением и
  // вставкой могла появиться строка настоящего портала (перекрытие контейнеров при rolling-обновлении
  // watchtower обрабатывает установку в старом, пока новый стартует). Выбор по `member_id` увёл бы
  // новый инстанс писать под плейсхолдер рядом с уже установленным порталом — то есть ровно в то
  // расщепление, от которого мы и уходим.
  const after = await pick()
  if (!after) throw new Error('ensureDefaultPortal: не удалось получить id портала')
  return after.id
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
