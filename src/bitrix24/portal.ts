import { LOCAL_PORTAL_MEMBER_ID, type Queryable } from '../store/types'
import { TokenCipher, encryptedBlobSchema } from './crypto'
import { Bitrix24OAuth, OAuthError, oauthTokensSchema, type OAuthTokens } from './oauth'

/**
 * Хранилище OAuth-токенов портала (ISSUE #3): пишет/читает `portal.tokens`
 * в зашифрованном виде (TokenCipher) и прозрачно обновляет протухший access-token.
 * Драйвер-агностично (`Queryable` — pg.Pool/pglite), без новой prod-зависимости.
 * tenant — `member_id` портала (Bitrix24-идентификатор).
 *
 * Устойчивость lifecycle (миграция 0004, docs/project-map.md, §Установка и lifecycle портала):
 *  - `updated_at` штампуется на install/refresh — основа keep-alive (`listNearExpiry`),
 *    иначе простаивающий портал теряет refresh_token на 180-й день;
 *  - `save` при install-событии сверяется с тумбстоуном (out-of-order install после
 *    uninstall не воскрешает удалённый портал), настоящая переустановка чистит тумбстоун;
 *  - `updateOnRefresh` — UPDATE-only: исчезла строка под конкурентным uninstall → UPDATE
 *    затрагивает 0 строк (возвращает false), портал остаётся удалён (второй, независимый
 *    от тумбстоуна гард против воскрешения);
 *  - `deletePortal` (ONAPPUNINSTALL) чистит все данные портала в транзакции.
 *
 * Известные ограничения координации (single-write DB-операции, вынесено в #4/§2.5):
 *  - `save`-гард — check-then-act (SELECT тумбстоуна → upsert) без лока: при РЕАЛЬНОЙ
 *    конкуренции install↔uninstall возможна интерлейсинг-гонка — с включением гарда на install-пути
 *    путь стал живым, поэтому три запроса идут одной транзакцией (если драйвер её умеет);
 *  - `updateOnRefresh` — одиночный DB-write ПОСЛЕ успешного OAuth-рефреша: при сбое персиста
 *    новые токены теряются, а сервер уже мог отозвать старый refresh_token. Общий лок между
 *    инстансами (advisory-lock) закроет оба случая при scale-out.
 */

/** Запас до истечения access-token: обновляемся заранее, чтобы не отдать почти-протухший (60 с). */
const REFRESH_SKEW_MS = 60_000

/** Срок жизни refresh_token Bitrix24 (дней). Порог keep-alive считается от него. */
export const REFRESH_TTL_DAYS = 180
/** Запас keep-alive: рефрешим за N дней до истечения refresh_token (полоса у истечения). */
export const KEEPALIVE_SKEW_DAYS = 3
const DAY_MS = 86_400_000

/**
 * Авторитетный резолвер install-маппинга `domain → member_id` для handshake app-фрейма (#47/#49):
 * по уже-провалидированному (SSRF-allowlist) домену портала отдаёт его `member_id` из таблицы
 * `portal` (заполняется при OAuth-установке, `PortalTokenStore.save`). undefined — портал не
 * установлен (handshake тогда fail-closed). Драйвер-агностично (`Queryable` — pg.Pool/pglite).
 *
 * Это боевая подмена no-op-резолвера, который `verifyFrameAuth`/`createPortalAuthenticator`
 * получают инъекцией (Nitro: `setPortalResolver`). member_id берётся из БД, НЕ из недоверенного
 * POST — анти-cross-tenant (сверку с заявленным делает `verifyFrameAuth`).
 */
export async function resolveMemberIdByDomain(db: Queryable, domain: string): Promise<string | undefined> {
  const r = await db.query<{ member_id: string }>(
    'select member_id from portal where domain = $1 limit 1',
    [domain]
  )
  return r.rows[0]?.member_id
}

/**
 * `member_id` УСТАНОВЛЕННОГО портала этого инстанса — для путей, где портал ниоткуда не приходит.
 *
 * Такой путь один: публичный `POST /api/submit` ([#177](https://github.com/bx-shef/polls/issues/177)).
 * Клиент отвечает по ссылке, ни фрейма, ни события портала там нет — а закрыть дело в таймлайне надо.
 *
 * ⚠️ Плейсхолдер (`__local__`) НЕ подходит: у него нет токенов, ходить в CRM нечем. `undefined` —
 * приложение ещё не установлено, и это штатный исход, а не ошибка: сервис умеет работать сам по себе.
 *
 * ⚠️ Single-tenant-допущение ([#49](https://github.com/bx-shef/polls/issues/49)): берётся самый ранний
 * установленный портал. При мультитенанте портал обязан приезжать из самого приглашения, а не
 * выбираться на процесс, — и эта функция подлежит удалению.
 */
export async function resolveInstalledMemberId(db: Queryable): Promise<string | undefined> {
  const r = await db.query<{ member_id: string }>(
    'select member_id from portal where member_id <> $1 order by id asc limit 1',
    [LOCAL_PORTAL_MEMBER_ID]
  )
  return r.rows[0]?.member_id
}

/** Опции сохранения токенов при установке. */
export interface SaveTokensOpts {
  /** Часы для `updated_at` (тест фиксирует). Default: `new Date()`. */
  now?: Date
  /**
   * unix-СЕКУНДЫ момента install-события (top-level `ts`, прижатый к «сейчас»). Если задан —
   * включается тумбстоун-гард: install не новее зафиксированного uninstall не воскрешает портал.
   * Роут установки его передаёт ВСЕГДА; опция остаётся необязательной только для ручных вызовов и
   * тестов, где гард не нужен (поведение как раньше — обычный upsert).
   */
  eventTs?: number
  /**
   * Присвоить плейсхолдер-порталу (`__local__`) настоящий `member_id` — ПЕРЕИМЕНОВАНИЕМ строки, а
   * не созданием новой ([#171](https://github.com/bx-shef/polls/issues/171)).
   *
   * ⚠️ Зачем. До связки с Bitrix весь трафик контура A пишется под плейсхолдер (`ensureDefaultPortal`),
   * и там же копятся ответы со снимками CRM — то есть ПДн. При установке появлялась ВТОРАЯ строка
   * портала, с настоящим `member_id`, и удаление приложения чистило именно её: `deletePortal`
   * находил портал без единого ответа, рапортовал об успехе, а персональные данные оставались в базе.
   * Требование Маркета «uninstall стирает PII» при этом формально выполнялось, фактически — нет.
   *
   * Переименование сохраняет числовой `portal.id`, поэтому уже открытый `PgStore` (он держит
   * `portalId`, а не `member_id`) продолжает работать без перезапуска, а все накопленные данные
   * разом становятся данными установленного портала.
   *
   * ⚠️ Присваиваем ТОЛЬКО когда плейсхолдер — единственная строка портала. Иначе непонятно, чьи это
   * данные, и присвоение отдало бы накопленное портала A порталу B. Роут установки передаёт флаг
   * всегда; решение принимает SQL.
   */
  adoptLocal?: boolean
  /**
   * Какой портал этот инстанс обслуживает (env `B24_EXPECTED_MEMBER_ID`). Задан — присваиваем
   * накопленное ТОЛЬКО ему; чужая установка получит `refused`.
   *
   * ⚠️ Зачем гейт. `verifyInstallMember` доказывает, что POST пришёл от настоящего портала X, но не
   * то, что X имеет отношение к данным под плейсхолдером. В частном развёртывании этого хватает:
   * приложение локальное, install-URL знает только владелец. В Маркете URL один на всех — и тогда
   * приложение может поставить кто угодно, включая модератора или партнёра с тестового портала. Без
   * гейта он присвоит чужие ПДн и сможет их стереть (uninstall с «очистить данные»).
   *
   * Не задан — присвоение работает как раньше. Дефолт выбран так, а не «выключено», потому что
   * выключенное по умолчанию присвоение оставило бы #171 открытым на самом обычном пути: владелец
   * ставит приложение, забыв про переменную, — и удаление данных снова ничего не стирает.
   */
  expectedMemberId?: string
}

/**
 * Опции подбора порталов у истечения refresh_token (keep-alive). Инвариант: `skewDays < ttlDays`
 * (иначе `cutoffOld` уходит в будущее и полоса теряет смысл) — дефолты его соблюдают.
 */
export interface NearExpiryOpts {
  /** Срок жизни refresh_token в днях. Default: `REFRESH_TTL_DAYS` (180). */
  ttlDays?: number
  /** За сколько дней до истечения освежать. Default: `KEEPALIVE_SKEW_DAYS` (3). */
  skewDays?: number
  /** Кап батча (bound на всплеск к OAuth-серверу). Default: 50. */
  limit?: number
}

/**
 * Сколько дней держать тумбстоун. Дефолт 30 суток — с огромным запасом: гард нужен, чтобы пережить
 * ОПОЗДАВШЕЕ событие той же деинсталляции (минуты и часы), а не месяцы.
 *
 * Клэмп [1, 365] и деградация мусора в дефолт: занижение до нуля выключило бы гард целиком, а
 * завышение на годы вернуло бы ту самую проблему, ради которой TTL и вводится, — вечную строку на
 * каждый навсегда удалённый портал.
 */
export const DEFAULT_TOMBSTONE_DAYS = 30
export const MIN_TOMBSTONE_DAYS = 1
export const MAX_TOMBSTONE_DAYS = 365
export function resolveTombstoneDays(raw: string | undefined): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOMBSTONE_DAYS
  return Math.min(MAX_TOMBSTONE_DAYS, Math.max(MIN_TOMBSTONE_DAYS, Math.trunc(n)))
}

/** Наблюдатели за событиями стора. Ядро про логгер не знает — событие отдаётся наружу колбэком. */
/**
 * Чем кончилась попытка присвоить плейсхолдер-портал.
 *
 * ⚠️ Наружу отдаются ВСЕ три исхода, а не только удачный. `skipped` и `refused` означают, что
 * накопленные ПДн остались за плейсхолдером и удаление приложения их не сотрёт — то есть #171 в этой
 * базе открыт и лечится руками. Молчание на этих ветках было бы худшим вариантом: работающим
 * выглядел бы именно провал.
 */
export type AdoptOutcome =
  /** Присвоено: строка плейсхолдера теперь принадлежит порталу. */
  | { kind: 'adopted'; memberId: string; portalId: number }
  /** Плейсхолдер есть, но настоящий портал в базе уже был — присваивать нельзя, чьи данные неясно. */
  | { kind: 'skipped'; memberId: string }
  /** Установка не от ожидаемого портала (`expectedMemberId`) — присвоение запрещено гейтом. */
  | { kind: 'refused'; memberId: string }

export interface PortalTokenStoreHooks {
  /**
   * Итог присвоения плейсхолдера (см. `SaveTokensOpts.adoptLocal`). Событие разовое и важное: на
   * `adopted` накопленные данные с этого момента принадлежат порталу и удаление приложения их сотрёт;
   * на `skipped`/`refused` — НЕ сотрёт, и это надо увидеть.
   */
  onAdopt?: (outcome: AdoptOutcome) => void
}

export class PortalTokenStore {
  constructor(
    private readonly db: Queryable,
    private readonly cipher: TokenCipher,
    private readonly hooks: PortalTokenStoreHooks = {}
  ) {}

  /** Шифрует токены в blob-строку для колонки `tokens` (единый формат для save/updateOnRefresh). */
  private sealBlob(tokens: OAuthTokens): string {
    return JSON.stringify(this.cipher.seal(JSON.stringify(tokens)))
  }

  /** Транзакция, если драйвер умеет; иначе — последовательные запросы (см. Queryable). */
  private inTx<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
    return this.db.transaction ? this.db.transaction(fn) : fn(this.db)
  }

  /**
   * Сохраняет токены портала при УСТАНОВКЕ (upsert по member_id), шифруя перед записью и
   * штампуя `updated_at`. Единый `save(tokens, opts)` вместо раздельного `saveOnInstall`
   * (обратно-совместимо, не трогает существующие вызовы).
   *
   * При `opts.eventTs` — тумбстоун-гард: если зафиксирован uninstall не старше события, запись
   * пропускается (портал не воскрешается устаревшими кредами) и возвращается `false`; настоящая
   * переустановка (строго новее) чистит устаревший тумбстоун. Возвращает `true`, если запись
   * выполнена. Refresh идёт отдельным путём (`updateOnRefresh`, UPDATE-only).
   */
  async save(tokens: OAuthTokens, opts: SaveTokensOpts = {}): Promise<boolean> {
    // Гонка check-then-act (SELECT тумбстоуна → upsert → DELETE) до активации гарда была теоретической,
    // теперь путь живой: параллельный uninstall между чтением и записью воскресил бы портал. Три
    // запроса идут одной транзакцией, если драйвер её умеет.
    const r = await this.inTx((db) => this.saveIn(db, tokens, opts))
    // ⚠️ Хук — ПОСЛЕ коммита, а не внутри транзакции. Изнутри он сообщал бы о присвоении, которого
    // могло не случиться: упади следующий запрос той же транзакции, всё откатится, а строка
    // «присвоено» уже лежала бы в логе — и разбор инцидента поехал бы по ложному следу.
    if (r.adoption) this.hooks.onAdopt?.(r.adoption)
    return r.saved
  }

  private async saveIn(
    db: Queryable,
    tokens: OAuthTokens,
    opts: SaveTokensOpts
  ): Promise<{ saved: boolean; adoption?: AdoptOutcome }> {
    const stampedAt = (opts.now ?? new Date()).toISOString()
    if (opts.eventTs !== undefined) {
      const blocked = await db.query(
        'select 1 from portal_tombstone where member_id = $1 and deleted_ts >= $2 limit 1',
        [tokens.memberId, opts.eventTs]
      )
      // out-of-order install после uninstall — не воскрешаем
      if (blocked.rows.length > 0) return { saved: false }
    }
    let adoption: AdoptOutcome | undefined
    if (opts.adoptLocal) {
      // ⚠️ Опциональный гейт: если инстанс знает, какой портал он обслуживает, чужая установка
      // накопленное НЕ присваивает. Без гейта (значение не задано) — сегодняшнее поведение частного
      // развёртывания: приложение локальное, install-URL знает только владелец. Перед публикацией в
      // Маркете гейт обязателен — там URL один на всех, см. §Ключевые решения.
      if (opts.expectedMemberId !== undefined && opts.expectedMemberId !== tokens.memberId) {
        adoption = { kind: 'refused', memberId: tokens.memberId }
      } else {
        // Плейсхолдер становится настоящим порталом. Условия в самом SQL, а не в коде: строка
        // плейсхолдера есть И настоящих порталов нет ни одного. Второе обязательно: при уже
        // установленном портале непонятно, чьи данные лежат под плейсхолдером, и присвоение отдало
        // бы накопленное одного портала другому.
        // `domain`/`updated_at`/`tokens` тут не трогаем: их всё равно перезапишет upsert ниже, в той
        // же транзакции. Меняем ровно то, что upsert выставить не может: владельца строки и дату
        // установки (иначе у присвоенного портала там навсегда осталась бы дата развёртывания).
        const adopted = await db.query<{ id: number }>(
          // `member_id = $3` формально избыточен (при живом `not exists` других строк и быть не может),
          // но оставлен намеренно: он выражает НАМЕРЕНИЕ «присваиваем именно плейсхолдер». Без него
          // ослабление `not exists` в будущем молча превратило бы это в «присвоить любой портал».
          `update portal set member_id = $1, installed_at = $2
            where member_id = $3
              and not exists (select 1 from portal p2 where p2.member_id <> $3)
            returning id`,
          [tokens.memberId, stampedAt, LOCAL_PORTAL_MEMBER_ID]
        )
        const id = adopted.rows[0]?.id
        if (id !== undefined) {
          adoption = { kind: 'adopted', memberId: tokens.memberId, portalId: id }
        } else {
          // Присвоения НЕ случилось. Молчать тут нельзя: это ровно тот исход, при котором
          // накопленные ПДн остаются за плейсхолдером и удаление приложения их не сотрёт, — то есть
          // #171 в этой базе остался открытым, и лечится он только руками.
          const stale = await db.query('select 1 from portal where member_id = $1 limit 1', [LOCAL_PORTAL_MEMBER_ID])
          if (stale.rows.length > 0) adoption = { kind: 'skipped', memberId: tokens.memberId }
        }
      }
    }
    await db.query(
      `insert into portal (member_id, domain, tokens, updated_at) values ($1, $2, $3, $4)
       on conflict (member_id) do update
         set tokens = excluded.tokens, domain = excluded.domain, updated_at = excluded.updated_at`,
      [tokens.memberId, tokens.domain ?? '', this.sealBlob(tokens), stampedAt]
    )
    if (opts.eventTs !== undefined) {
      // Настоящая переустановка (строго новее любого зафиксированного uninstall) — чистим тумбстоун.
      await db.query(
        'delete from portal_tombstone where member_id = $1 and deleted_ts < $2',
        [tokens.memberId, opts.eventTs]
      )
    }
    return adoption !== undefined ? { saved: true, adoption } : { saved: true }
  }

  /**
   * Персист СВЕЖЕЙ пары токенов после refresh — **UPDATE-only** (никогда INSERT): если строка
   * портала исчезла под конкурентным uninstall, UPDATE затрагивает 0 строк и возвращает `false`
   * (портал остаётся удалён — второй, независимый от тумбстоуна гард против воскрешения; вызывающий
   * трактует `false` как «портал ушёл»). `true` — токены записаны. Штампует `updated_at`.
   */
  async updateOnRefresh(tokens: OAuthTokens, now: Date = new Date()): Promise<boolean> {
    const r = await this.db.query(
      'update portal set tokens = $1, domain = $2, updated_at = $3 where member_id = $4 returning member_id',
      [this.sealBlob(tokens), tokens.domain ?? '', now.toISOString(), tokens.memberId]
    )
    return r.rows.length > 0
  }

  /**
   * Подмести тумбстоуны старше `days` дней. Возвращает число удалённых строк.
   *
   * Зачем вообще подметать. Тумбстоун решает узкую задачу: пережить ОПОЗДАВШЕЕ событие установки той
   * же деинсталляции. Опоздание измеряется минутами и часами — ретрай вебхука, задержка на стороне
   * Bitrix. Держать запись дольше незачем, а вот вреда от неё два: на каждый навсегда удалённый портал
   * копится строка, и настоящая переустановка через год упирается в гард, поставленный годом раньше.
   *
   * ⚠️ Единица времени выбрана так, чтобы ошибка деградировала БЕЗОПАСНО. `deleted_ts` — unix-СЕКУНДЫ,
   * и сравнение идёт с `extract(epoch from now())`. Если куда-то просочится значение в миллисекундах,
   * оно окажется в далёком будущем — то есть такая строка просто никогда не подметётся. Обратный
   * вариант (сравнивать в миллисекундах) снёс бы секундные записи МГНОВЕННО, то есть выключил бы гард
   * ровно тогда, когда он нужен.
   */
  async sweepTombstones(days: number): Promise<number> {
    // `Math.trunc(NaN)` — это NaN, а `Math.max(1, NaN)` — тоже NaN: без явной проверки клэмп не
    // клэмпит, и Postgres, считая NaN больше любого числа, снёс бы ВСЮ таблицу, включая свежие записи.
    const safeDays = Number.isFinite(days) ? Math.trunc(days) : DEFAULT_TOMBSTONE_DAYS
    const seconds = Math.max(MIN_TOMBSTONE_DAYS, safeDays) * 86_400
    // `returning` вместо `rowCount`: контракт `Queryable` отдаёт только `rows` — он общий для
    // pg-пула и pglite, и лишнее поле привязало бы ядро к конкретному драйверу.
    // Вторая ветка — записи «из будущего»: сегодня их создать нельзя (запись клэмпится к `nowSec`),
    // но попавшая раньше лежала бы вечно и блокировала установку для своего member_id — `deleted_ts
    // < now - ttl` для неё ложно всегда. Подметаем и их.
    const res = await this.db.query(
      `delete from portal_tombstone
       where deleted_ts < extract(epoch from now()) - $1 or deleted_ts > extract(epoch from now())
       returning member_id`,
      [seconds]
    )
    return res.rows.length
  }

  /**
   * Удаление портала при ONAPPUNINSTALL. В ТРАНЗАКЦИИ (если драйвер умеет): СНАЧАЛА пишет тумбстоун
   * `(member_id, deleted_ts)` (`greatest` при повторной доставке — хранит новейший uninstall),
   * ПОТОМ каскадно удаляет данные портала в порядке зависимостей (FK на `portal(id)` — без
   * `on delete cascade`, поэтому чистим вручную; `response` каскадит свои answer/product/insight).
   * `deletedTs` — unix-СЕКУНДЫ (top-level `ts` вебхука). Требование Маркета: uninstall стирает PII.
   */
  async deletePortal(memberId: string, deletedTs: number): Promise<void> {
    const pidSub = '(select id from portal where member_id = $1)'
    await this.inTx(async (db) => {
      await db.query(
        `insert into portal_tombstone (member_id, deleted_ts) values ($1, $2)
         on conflict (member_id) do update set deleted_ts = greatest(portal_tombstone.deleted_ts, excluded.deleted_ts)`,
        [memberId, deletedTs]
      )
      // Порядок: дети → родители. response и invitation ссылаются на survey/version, поэтому раньше.
      await db.query(`delete from response where portal_id = ${pidSub}`, [memberId])
      await db.query(`delete from invitation where portal_id = ${pidSub}`, [memberId])
      const groupScope = `g.portal_id = ${pidSub}`
      await db.query(
        `delete from survey_option where question_id in (
           select q.id from survey_question q
           join survey_version v on q.version_id = v.id
           join survey s on v.survey_id = s.id
           join survey_group g on s.group_id = g.id where ${groupScope})`,
        [memberId]
      )
      await db.query(
        `delete from survey_question where version_id in (
           select v.id from survey_version v
           join survey s on v.survey_id = s.id
           join survey_group g on s.group_id = g.id where ${groupScope})`,
        [memberId]
      )
      await db.query(
        `delete from survey_version where survey_id in (
           select s.id from survey s join survey_group g on s.group_id = g.id where ${groupScope})`,
        [memberId]
      )
      await db.query(
        `delete from survey where group_id in (select id from survey_group where portal_id = ${pidSub})`,
        [memberId]
      )
      await db.query(`delete from survey_group where portal_id = ${pidSub}`, [memberId])
      await db.query(`delete from app_user where portal_id = ${pidSub}`, [memberId])
      await db.query('delete from portal where member_id = $1', [memberId])
    })
  }

  /**
   * member_id порталов в «полосе у истечения» refresh_token — для keep-alive-рефреша:
   * `updated_at` старше `now - (ttlDays - skewDays)` (пора освежать), но не старше
   * `now - ttlDays` (нижняя граница отсекает уже мёртвые/отозванные гранты, иначе они бы
   * монополизировали батч с фиксированным `updated_at`). Сортировка по возрасту, кап батча.
   */
  async listNearExpiry(now: Date = new Date(), opts: NearExpiryOpts = {}): Promise<string[]> {
    const ttlDays = opts.ttlDays ?? REFRESH_TTL_DAYS
    const skewDays = opts.skewDays ?? KEEPALIVE_SKEW_DAYS
    const limit = opts.limit ?? 50
    const cutoffOld = new Date(now.getTime() - (ttlDays - skewDays) * DAY_MS).toISOString()
    const ttlFloor = new Date(now.getTime() - ttlDays * DAY_MS).toISOString()
    const r = await this.db.query<{ member_id: string }>(
      `select member_id from portal where updated_at < $1 and updated_at >= $2
       order by updated_at asc limit $3`,
      [cutoffOld, ttlFloor, limit]
    )
    return r.rows.map((row) => row.member_id)
  }

  /**
   * Читает и расшифровывает токены портала; undefined — портал не установлен.
   * При повреждении blob / расшифровке другим ключом бросает `OAuthError`
   * (а не «голый» crypto/Zod-error) — чтобы вызывающий мог ловить единый тип.
   */
  async load(memberId: string): Promise<OAuthTokens | undefined> {
    const r = await this.db.query<{ tokens: unknown }>(
      'select tokens from portal where member_id = $1 limit 1',
      [memberId]
    )
    const row = r.rows[0]
    if (!row) return undefined
    try {
      // jsonb драйвер отдаёт уже разобранным объектом (pg.Pool и pglite одинаково)
      const blob = encryptedBlobSchema.parse(row.tokens)
      return oauthTokensSchema.parse(JSON.parse(this.cipher.open(blob)))
    } catch {
      // Сообщение без содержимого токенов: только идентификатор портала.
      throw new OAuthError(`Не удалось прочитать токены портала ${memberId} (повреждение или другой ключ шифрования)`)
    }
  }

  /**
   * Действующий access-token портала: если протух (с запасом REFRESH_SKEW_MS) —
   * рефрешит через OAuth, перешифровывает и сохраняет (`updateOnRefresh`, UPDATE-only).
   * undefined — портал не установлен ИЛИ удалён под гонкой во время refresh (persist 0 строк).
   * Бросает OAuthError, если refresh не удался.
   */
  async accessToken(memberId: string, oauth: Bitrix24OAuth, now: Date = new Date()): Promise<string | undefined> {
    const tokens = await this.load(memberId)
    if (!tokens) return undefined
    if (new Date(tokens.expiresAt).getTime() - REFRESH_SKEW_MS > now.getTime()) {
      return tokens.accessToken
    }
    const refreshed = await oauth.refresh(tokens.refreshToken)
    // Защита от записи в чужой tenant, если сервер вернул другой member_id.
    if (refreshed.memberId !== memberId) {
      throw new OAuthError(`OAuth вернул токены чужого портала (ожидали ${memberId})`)
    }
    // Портал мог быть удалён (uninstall) во время refresh — не отдаём токен «мёртвого» портала.
    if (!(await this.updateOnRefresh(refreshed, now))) return undefined
    return refreshed.accessToken
  }
}
