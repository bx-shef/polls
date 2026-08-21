import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createApi, type Api, type AnsweredInfo } from '~core/api/handlers'
import { buildDemo } from '~core/demo/seed'
import { createJsonLogger, type Logger } from '~core/obs/logger'
import { SlidingWindowLimiter } from '~core/api/ratelimit'
import { MemoryNonceStore } from '~core/api/nonce'
import {
  MemoryInvitationStore,
  type InvitationCreate, type InvitationPin, type InvitationStore
} from '~core/api/invitation'
import {
  DEMO_INVITATION_CONTEXT, DEMO_INVITATION_CONTEXT_2,
  DEMO_INVITATION_TOKEN, DEMO_INVITATION_TOKEN_2, SURVEY_KEY
} from '~core/demo/seed'
import { surveyRoutingFromEnv } from '~core/bitrix24/survey-routing'
import { PgStore, queryableFromPool } from '~core/store/pg'
import { PgInvitationStore } from '~core/store/pg-invitation'
import { applyMigrations, upSql } from '~core/store/migrate'
import { ensureDefaultPortal, isPlaceholderPortal, seedDemoIfEmpty } from '~core/store/bootstrap'
import { resolveMemberIdByDomain } from '~core/bitrix24/portal'
import type { IStore, Queryable } from '~core/store/types'
import { setPortalResolver } from './b24-session'
import type { H3Event } from 'h3'
import { clientIp, resolveTrustedProxies, FORWARDED_FOR_HEADER } from '~core/api/client-ip'

/**
 * Nitro-привязка ядра. SERVER-ONLY: `~core/api`/`~core/store`/`~core/obs`/`~core/bitrix24` сюда
 * импортируются намеренно (Nitro-роуты, гарантия — server-каталог Nuxt), в клиентский бандл не попадают.
 *
 * Стор выбирается по `DATABASE_URL` (#6):
 *  - задан → **PgStore** (PostgreSQL): миграции на boot → tenant-портал → засев демо в пустую БД →
 *    боевой резолвер `domain → member_id` для handshake. Данные СОХРАНЯЮТСЯ между рестартами.
 *  - не задан → **MemoryStore + seed** (dev/демо, паритет с `pnpm serve`; данные эфемерны).
 * ОДИН инстанс на процесс (`useStore`) — общий для `/api/*` (контур A) и дашборда (контур B).
 */
let storePromise: Promise<IStore> | undefined
let apiPromise: Promise<Api> | undefined
/** pg-Queryable активного PgStore (для PortalTokenStore установки, #17); undefined на MemoryStore. */
let pgDb: Queryable | undefined
/** portalId активного PgStore — нужен приглашениям (tenant-скоуп задаётся конструктором). */
let pgPortalId: number | undefined

export const logger: Logger = createJsonLogger({ base: { svc: 'polls' } })

/** pg-Queryable, если приложение на PgStore (DATABASE_URL задан); иначе undefined. Гарантирует инициализацию стора. */
export async function usePortalDb(): Promise<Queryable | undefined> {
  await useStore()
  return pgDb
}

/**
 * Сбросить закэшированные на процесс стор/API/приглашения — так, чтобы следующий вызов собрал их
 * заново (перечитав `portal`).
 *
 * ⚠️ Зовётся ровно из одного места: после успешного `deletePortal` на удалении приложения
 * ([#171](https://github.com/bx-shef/polls/issues/171)). Раньше плейсхолдер-портал переживал
 * uninstall — удалялась вторая, пустая строка, — и инстанс продолжал работать. Теперь строка одна и
 * та же: `deletePortal` сносит РОВНО ту, на числовой `portal.id` которой прибиты `PgStore` и
 * `PgInvitationStore`. Без сброса каждая последующая запись падала бы на FK
 * (`survey_group_portal_id_fkey`), причём **тихо для наблюдателя**: install-страница рисует
 * «Приложение установлено», а `GET /api/health` остаётся зелёным — `ping` это `select 1`, порталов
 * он не касается. Переустановка без рестарта не лечила бы: новая строка получает НОВЫЙ id, а кэш
 * держит старый.
 *
 * Пул соединений (`pgDb`) намеренно НЕ трогаем: он не привязан к порталу, а его пересоздание на
 * каждом uninstall стоило бы дороже пользы.
 */
export function resetStoreCache(): void {
  storePromise = undefined
  apiPromise = undefined
  invitationStore = undefined
  pgPortalId = undefined
  // ⚠️ Пер-портальные кэши чистятся ТЕМ ЖЕ вызовом (#49). Они держат `portalId` удалённой строки
  // ровно так же, как процессный кэш: пропустить их значит оставить живой стор, чья каждая запись
  // упрётся в FK, — и снова тихо, потому что install-страница и `/api/health` этого не видят.
  storesByPortal.clear()
  invitationsByPortal.clear()
  apisByPortal.clear()
}

/**
 * Числовой `portal.id`, под которым пишет стор этого инстанса; `undefined` — режим памяти.
 *
 * ⚠️ Нужен закрытию дела-приглашения (#177), чтобы оно ходило в ТОТ ЖЕ портал, куда пишет стор.
 * Отдельный резолвер («первый установленный») разъезжался бы с этим выбором молча.
 */
export async function usePortalId(): Promise<number | undefined> {
  await useStore()
  return pgPortalId
}

export function useStore(): Promise<IStore> {
  if (!storePromise) {
    storePromise = buildStore().catch((e) => {
      storePromise = undefined
      throw e
    })
  }
  return storePromise
}

/** up-SQL миграций из каталога `migrations/` (в образе COPY'нут в /app/migrations). */
function readMigrationSqls(): string[] {
  const dir = join(process.cwd(), 'migrations')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => upSql(readFileSync(join(dir, f), 'utf8')))
}

async function buildStore(): Promise<IStore> {
  const url = process.env.DATABASE_URL
  if (!url) {
    // Dev/демо: данные эфемерны. Явный сигнал, если окружение выглядит боевым.
    if (process.env.NODE_ENV === 'production') {
      logger.warn('store_dev_memory', {
        msg: 'DATABASE_URL не задан — MemoryStore+seed (данные эфемерны). Для постоянства задайте DATABASE_URL (#6)'
      })
    }
    return buildDemo()
  }
  // Прод: PostgreSQL. Динамический import — pg тянется только на сервере с заданным DATABASE_URL.
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: url })
  // pg эмитит 'error' на idle-клиенте (рестарт БД / обрыв сети). БЕЗ слушателя это событие на
  // EventEmitter роняет процесс (унося приглашения/nonce из памяти). Логируем — пул сам переподнимет
  // соединение к следующему запросу.
  pool.on('error', (e: Error) => logger.warn('pg_pool_error', { msg: e.message }))
  const db: Queryable = queryableFromPool(pool)
  pgDb = db // доступен для PortalTokenStore (установка #17)
  await applyMigrations(db, readMigrationSqls())
  // Портал ПО УМОЛЧАНИЮ — фолбэк для путей, где портала нет вовсе (см. `ensureDefaultPortal`).
  // Портал запроса выбирают `storeFor`/`invitationsFor`/`useApiFor` (#49).
  const portalId = await ensureDefaultPortal(db, {
    onAmbiguous: (chosen, all) =>
      logger.info('store_default_portal', {
        // ⚠️ Второй аргумент — СПИСОК member_id, а не число. Первая редакция подставляла его как
        // количество («Порталов в базе m-a,m-b»), и лог, заведённый ради предсказуемости выбора,
        // сам врал про то, что печатает.
        msg: `Порталов в базе ${all.length} (${all.join(', ')}); фолбэк-стор (запрос без портала) пишет под ${chosen}`
      })
  })
  pgPortalId = portalId
  // `requireTransaction` — не педантизм: без транзакции отказ между вставкой `response` и
  // `response_answer` оставит пустой ответ, а повтор упрётся в дедуп по токену и получит 409 «опрос
  // пройден» (#170). Флаг падает на старте, если драйвер транзакций не умеет, — вместо тихой
  // неатомарной записи. `queryableFromPool` их умеет, так что это страховка от будущей подмены.
  const store = new PgStore(db, { portalId, requireTransaction: true })
  // ⚠️ Демо — ТОЛЬКО в плейсхолдер (#47/#49). Портал по умолчанию с мультитенантом это самый ранний
  // НАСТОЯЩИЙ портал: без гейта удаление первого арендатора превращало бы второго в получателя
  // демо-опроса и дюжины выдуманных ответов. Разбор — `seedDemoIfEmpty`.
  if (await isPlaceholderPortal(db, portalId) && await seedDemoIfEmpty(store)) {
    logger.info('store_seeded', { msg: 'Демо-опрос засеян в пустую БД под плейсхолдер-портал (#6)' })
  }
  // Боевой резолвер handshake app-фрейма: domain → member_id из таблицы portal (#47/#49).
  setPortalResolver((domain) => resolveMemberIdByDomain(db, domain))
  logger.info('store_pg', { msg: 'PgStore активен (PostgreSQL) — данные сохраняются между рестартами' })
  return store
}

/**
 * Стор и приглашения ПО ПОРТАЛУ (#49).
 *
 * ⚠️ Раньше и то и другое выбиралось на процесс: портал был один, и `portalId` жил глобалом. С
 * несколькими порталами это означало бы, что ответы одного заказчика ложатся в данные другого —
 * тихо, потому что снаружи всё выглядит рабочим. Теперь портал — ПАРАМЕТР, а не состояние.
 *
 * Мемоизация по `portalId` — гигиена, а не защита: один `PgStore`/`Api` на портал вместо объекта на
 * каждый запрос. Анти-абьюз она НЕ держит — лимитер и nonce-стор общие и живут отдельными
 * синглтонами (`sharedLimiter`/`sharedNonces`); первая редакция этого комментария утверждала
 * обратное, и опровергалась строкой тридцатью ниже, в том же файле.
 */
const storesByPortal = new Map<number, IStore>()
const invitationsByPortal = new Map<number, InvitationStore>()
const apisByPortal = new Map<number, Api>()

/** Стор нужного портала. Без БД (режим памяти) — общий демо-стор: порталов там нет. */
export async function storeFor(portalId: number | undefined): Promise<IStore> {
  if (portalId === undefined) return useStore()
  const db = await usePortalDb()
  if (!db) return useStore()
  const cached = storesByPortal.get(portalId)
  if (cached) return cached
  const store = new PgStore(db, { portalId, requireTransaction: true })
  storesByPortal.set(portalId, store)
  return store
}

/** Приглашения нужного портала. */
export async function invitationsFor(portalId: number | undefined): Promise<InvitationStore> {
  if (portalId === undefined) return useInvitations()
  const db = await usePortalDb()
  if (!db) return useInvitations()
  const cached = invitationsByPortal.get(portalId)
  if (cached) return cached
  const store = new PgInvitationStore(db, { portalId })
  invitationsByPortal.set(portalId, store)
  return store
}

/**
 * `Api`, обслуживающий КОНКРЕТНЫЙ портал.
 *
 * ⚠️ Лимитер и nonce-стор — ОБЩИЕ на все порталы, и это не экономия: они защищают наш сервис от
 * флуда по IP, а не данные тенанта. Раздельные счётчики означали бы, что злоумышленник обходит
 * лимит, чередуя порталы.
 */
export async function useApiFor(portalId: number | undefined): Promise<Api> {
  if (portalId === undefined) return useApi()
  const db = await usePortalDb()
  if (!db) return useApi()
  const cached = apisByPortal.get(portalId)
  if (cached) return cached
  const api = createApi({
    store: await storeFor(portalId),
    invitations: await invitationsFor(portalId),
    logger,
    limiter: sharedLimiter(),
    nonces: sharedNonces(),
    onAnswered: onAnsweredHookFor(portalId)
  })
  apisByPortal.set(portalId, api)
  return api
}

export function useApi(): Promise<Api> {
  if (!apiPromise) {
    // Проваленную инициализацию НЕ кэшируем (иначе сервер не поднимется без рестарта).
    apiPromise = buildApi().catch((e) => {
      apiPromise = undefined
      throw e
    })
  }
  return apiPromise
}

/**
 * ОБЩИЙ стор приглашений на процесс: его пишет триггер/виджет (создаёт приглашение по сделке) и
 * расходует `submit` — поэтому createApi получает ИМЕННО этот инстанс, а не создаёт свой.
 * Реализация выбирается по `DATABASE_URL`: PostgreSQL (#4, переживает перезапуск) либо память.
 */
// ⚠️ Тип возврата — ПОРТ `InvitationStore`, а не класс. Пока здесь стоял `MemoryInvitationStore`,
// все четыре вызывающих роута были прибиты к конкретной реализации, и подмена на durable-стор (#4)
// требовала бы правки каждого из них — при том что сам порт существовал.
let invitationStore: InvitationStore | undefined
export function useInvitations(): InvitationStore {
  if (!invitationStore) invitationStore = new LazyInvitationStore()
  return invitationStore
}

/**
 * Стор приглашений с ЛЕНИВЫМ выбором реализации.
 *
 * ⚠️ Обёртка нужна из-за раскладки, а не из любви к слоям: `useInvitations()` синхронна и зовётся из
 * четырёх мест, а пул БД и `portalId` доступны только через `await useStore()`. Сделать фабрику
 * асинхронной значило бы править все вызывающие — ровно то, чего избегали, разводя порт. Поэтому
 * реализация резолвится внутри уже асинхронных методов порта, один раз на процесс.
 *
 * Без `DATABASE_URL` — память (демо/dev): там и данных нет, и переживать перезапуск нечему.
 */
class LazyInvitationStore implements InvitationStore {
  private resolved: Promise<InvitationStore> | undefined

  private real(): Promise<InvitationStore> {
    if (!this.resolved) {
      this.resolved = (async () => {
        await useStore() // поднимает пул и заполняет pgDb/pgPortalId
        if (pgDb && pgPortalId !== undefined) {
          logger.info('invitations_pg', { msg: 'Приглашения в PostgreSQL — переживают перезапуск (#4)' })
          return new PgInvitationStore(pgDb, { portalId: pgPortalId })
        }
        return new MemoryInvitationStore()
      })().catch((e) => {
        // Проваленный резолв НЕ кэшируем: иначе одна неудача на старте выключила бы приглашения до
        // рестарта. Следующий вызов попробует снова.
        this.resolved = undefined
        throw e
      })
    }
    return this.resolved
  }

  async create(input: InvitationCreate, now: Date) {
    return (await this.real()).create(input, now)
  }

  async peek(token: string, now: Date) {
    return (await this.real()).peek(token, now)
  }

  async consume(token: string, pin: InvitationPin, now: Date) {
    return (await this.real()).consume(token, pin, now)
  }
}

/**
 * Демо-режим — ровно то же условие, по которому выбирается стор: `DATABASE_URL` не задан.
 *
 * ⚠️ Ревью предлагало второй замок `NODE_ENV !== 'production'`, и его тут НЕТ намеренно: у нас
 * собранный сервер бежит как production ВСЕГДА — им же поднимается визуальный гейт
 * (`playwright.config.ts`, `node .output/server/index.mjs`), и демо-стенд тоже. То есть `NODE_ENV`
 * у нас не различает «боевой запуск» и «демо-запуск», и такой замок молча выключил бы демо-данные
 * там, где они и нужны. Плюс он гасил бы только приглашения: демо-ОПРОСЫ приходят из `useStore()`
 * по тому же `DATABASE_URL`, и расхождение двух условий — это как раз тот класс ошибок, из-за
 * которого демо «работает», но показывает не то.
 *
 * Реальная граница остаётся снаружи процесса: `pnpm env:check` считает отсутствие `DATABASE_URL`
 * ошибкой деплоя. Отдельная явная переменная демо-режима — это уже разговор про то, чтобы и стор
 * выбирался ею же; заведено отдельной задачей, а не полумерой здесь.
 */
function isDemoMode(): boolean {
  return !process.env.DATABASE_URL
}

/**
 * Маршрутизация опросов по сущности (`SURVEY_KEY_<ENTITY>`/`SURVEY_KEY_DEFAULT`) — собирается ОДИН РАЗ
 * на процесс (конфиг статичен на время жизни инстанса), как `useStore`/`useInvitations`. Виджет
 * deal-invite зовёт `surveyKeyForEntity(entity, useSurveyRouting().routing, .fallback)`.
 */
let surveyRouting: ReturnType<typeof surveyRoutingFromEnv> | undefined
export function useSurveyRouting(): ReturnType<typeof surveyRoutingFromEnv> {
  if (!surveyRouting) surveyRouting = surveyRoutingFromEnv(process.env)
  return surveyRouting
}

/**
 * Демо-приглашения: в режиме без БД заводим ДВА, с фиксированными токенами — на разные сделки.
 *
 * ⚠️ Иначе демо не умеет показать главный путь продукта — ссылку из CRM. Открыв `/s/:key`, человек
 * видит опрос без привязки к сделке, то есть ровно то состояние, из-за которого аналитика и не
 * работает. Плюс визуальный гейт: без живого приглашения он проверял бы клиентский мок вместо
 * настоящего пути.
 *
 * Токен не секрет: он существует только там, где нет боевых данных. В боевом режиме
 * ({@link isDemoMode} ложен) приглашения выписывает только связка с порталом, и этой ветки нет вовсе.
 *
 * ⚠️ Токен задаётся ЗДЕСЬ, параметром `create`, а не генератором стора. Генератор висит на сторе, а
 * `useInvitations()` зовут напрямую и роуты `deal-invite`/`deal-update`/`robot` — то есть резерв
 * «первые два токена фиксированы» доставался тому, кто позвал первым, включая реальную сделку.
 */
async function seedDemoInvitation(invitations: InvitationStore): Promise<void> {
  if (!isDemoMode()) return
  const store = await useStore()
  const version = await store.currentVersion(SURVEY_KEY)
  if (!version) return
  const year = 365 * 24 * 60 * 60_000
  // Два приглашения на ОДИН опрос, но на разные сделки — иначе не показать (и не проверить) главное
  // правило привязки: черновик по одной ссылке не переносится на другую.
  const demo = [
    { token: DEMO_INVITATION_TOKEN, context: DEMO_INVITATION_CONTEXT },
    { token: DEMO_INVITATION_TOKEN_2, context: DEMO_INVITATION_CONTEXT_2 }
  ]
  for (const { token, context } of demo) {
    await invitations.create({
      token,
      surveyKey: SURVEY_KEY,
      versionNo: version.versionNo,
      context: { ...context },
      ttlMs: year
    }, new Date())
  }
}

/**
 * Лимитер и nonce-стор — ОБЩИЕ на все порталы (#49).
 *
 * ⚠️ Не экономия: они защищают наш сервис от флуда по IP, а не данные тенанта. Раздельные счётчики
 * означали бы, что лимит обходится чередованием порталов.
 *
 * Щедрый потолок — для dev/gate-сервера: SSR-рендер сам дёргает `/api/survey/:key/current`
 * (server-to-server, один loopback-IP), и визуальный гейт прогоняет страницу многократно — дефолтные
 * 10/60с быстро упираются в 429 (флаки гейта). Это НЕ прод-граница анти-абьюза (она по IP за
 * доверенным прокси + общий стор, #4/#6); здесь высокий потолок убирает ложные 429, оставляя
 * ceiling от примитивного флуда.
 */
let limiterOnce: SlidingWindowLimiter | undefined
export function sharedLimiter(): SlidingWindowLimiter {
  if (!limiterOnce) limiterOnce = new SlidingWindowLimiter({ limit: 1000, windowMs: 60_000 })
  return limiterOnce
}
let noncesOnce: MemoryNonceStore | undefined
function sharedNonces(): MemoryNonceStore {
  if (!noncesOnce) noncesOnce = new MemoryNonceStore()
  return noncesOnce
}

/**
 * Побочные действия после записи ответа: закрыть дело-приглашение в таймлайне (#177).
 *
 * Динамический импорт разрывает цикл `api.ts → close-invite.ts → api.ts` (модулю нужны `usePortalDb`
 * и `logger` отсюда же). Он же оставляет путь без БД нетронутым: модуль просто не грузится.
 */
function onAnsweredHookFor(portalId?: number): (info: AnsweredInfo) => Promise<void> {
  return async (info: AnsweredInfo): Promise<void> => {
    const { closeInvite } = await import('./close-invite')
    const { postResult } = await import('./post-result')
    const { livePortalDeps } = await import('./portal-deps')
    // ⚠️ Портал ПРОКИДЫВАЕТСЯ (#49): и закрытие дела, и запись результата идут в тот же портал, где
    // записан ответ. Пока портал резолвился внутри («тот, под которым пишет стор процесса»), ответ
    // клиента одного заказчика уходил бы в CRM другого — с его токенами и его сделками.
    const deps = livePortalDeps(portalId)
    // ⚠️ ПАРАЛЛЕЛЬНО, а не по очереди. У каждого действия свой дедлайн в 3 секунды; последовательный
    // запуск дал бы шесть секунд ожидания человеку, который уже нажал «Отправить», — на самом видимом
    // клиенту экране. Клиент портала у них общий (кэш в `portal-deps`), так что второй получает
    // готовый: параллельность стоит одного лишнего промиса, а не второго рефреша токена.
    // ⚠️ `Promise.all` безопасен: оба действия ловят свои отказы внутри и наружу их не пробрасывают.
    await Promise.all([closeInvite(info, deps), postResult(info, deps)])
  }
}

async function buildApi(): Promise<Api> {
  const store = await useStore()
  const invitations = useInvitations()
  await seedDemoInvitation(invitations)
  return createApi({
    store,
    logger,
    limiter: sharedLimiter(),
    nonces: sharedNonces(),
    invitations,
    // Без явного портала — процессный (`usePortalId()` внутри), как было до мультитенанта.
    onAnswered: onAnsweredHookFor()
  })
}

/**
 * Адрес клиента для ключа анти-абьюза — ЕДИНАЯ точка на все роуты.
 *
 * Штатный `getRequestIP(event)` без параметров отдаёт адрес сокета, а за нашим обратным прокси это
 * адрес прокси: одинаковый для всех, то есть все лимитеры вырождаются в один общий счётчик на весь
 * сервис. С флагом `xForwardedFor: true` он берёт ПЕРВЫЙ адрес заголовка — а его пишет отправитель
 * запроса, и лимит обходится одной строкой. Оба варианта выглядят рабочими и не работают, поэтому
 * решение вынесено в чистую `clientIp` (под тестами), а роуты зовут её отсюда.
 *
 * Сколько своих прокси перед приложением — `TRUSTED_PROXIES` (по умолчанию 0: заголовок игнорируется).
 * Значение читается на каждый запрос, и причина не в «перенастройке без пересборки» (менять env в
 * работающем контейнере всё равно нельзя), а в том, что модуль не держит состояния: одна чистая
 * функция плюс чтение окружения в момент вызова тестируются и читаются проще, чем закешированное на
 * старте значение, а стоимость — `process.env` + разбор короткой строки на фоне запроса в БД.
 */
export function requestIp(event: H3Event): string {
  return clientIp({
    socketIp: getRequestIP(event),
    forwardedFor: getRequestHeader(event, FORWARDED_FOR_HEADER),
    trustedProxies: resolveTrustedProxies(process.env.TRUSTED_PROXIES)
  })
}
