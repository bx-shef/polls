import { randomUUID } from 'node:crypto'
import type { CrmContext, Invitation } from '../domain/schema'

/**
 * Стор приглашений (invitation-flow #3) по образцу `MemoryNonceStore`: `create`
 * кладёт СНИМОК CRM-контекста под одноразовый токен, `consume` его расходует — но
 * только при совпадении пина опроса/версии (чужой пин НЕ сжигает токен). Single-use
 * = идемпотентность `addResponse` по приглашению (#4).
 *
 * ✅ **Реализаций две:** `MemoryInvitationStore` (демо/dev, ниже в этом файле) и `PgInvitationStore`
 * (`store/pg-invitation.ts`, при заданном `DATABASE_URL`) — приглашения переехали в БД и переживают
 * перезапуск. Паритет поведения двух реализаций держит контрактный тест в `test/pg-invitation.test.ts`
 * (он уже поймал одно расхождение: порядок проверок «использована» и «протухла»).
 *
 * ⚠️ Прежняя оговорка «как у nonce/rate-limit» снята: сторы разъехались по срочности. Приглашения
 * переехали первыми (без этого не закрыть #138 и #126), nonce — вслед за scale-out, а **лимитер
 * в Postgres не поедет вовсе**: `allow()` зовётся до разбора тела на публичных путях, и round-trip в
 * БД на каждый запрос превратил бы защиту от флуда в усилитель флуда по самой БД. Ему нужен Redis или
 * ничего; потеря окна при рестарте стоит ≤60 секунд fail-open. Подробно — карта, §Ключевые решения.
 */
export interface InvitationCreate {
  surveyKey: string
  versionNo: number
  context: CrmContext
  /** TTL приглашения в мс (по умолчанию — из стора). */
  ttlMs?: number
  /**
   * Задать токен явно — ТОЛЬКО для демо-засева (`seedDemoInvitation`), где ссылку надо знать
   * заранее. Боевые вызывающие поле не ставят, и токен им генерирует стор.
   *
   * ⚠️ Первая попытка сделать это через `idGen` стора («первые два выданных токена фиксированы»)
   * оказалась дефектом: генератор висит на СТОРЕ, а `useInvitations()` зовут напрямую и
   * `deal-invite`/`deal-update`/`robot`, минуя засев. На холодном процессе без БД первые два
   * БОЕВЫХ приглашения получали опубликованные в репозитории токены — то есть чужой ответ можно
   * было вписать в реальную сделку. Здесь резерв привязан к своему единственному владельцу.
   *
   * ⚠️ Почему это НЕ «возможность назначить чужой токен» снаружи: ни одна HTTP-схема токен на
   * запись не принимает, а единственный боевой строитель `InvitationCreate`
   * (`bitrix24/trigger.ts:createSurveyInvitation`) собирает объект из фиксированного набора полей
   * и до тела запроса не дотягивается — это держит `test/trigger.test.ts` (исполняемый гард, не
   * grep) и typecheck.
   */
  token?: string
}

/** Пин опроса/версии, к которому привязан токен (сверяется при расходе). */
export interface InvitationPin {
  surveyKey: string
  versionNo: number
}

export type InvitationConsume =
  | { status: 'ok'; invitation: Invitation }
  | { status: 'replay' }
  | { status: 'mismatch' }
  | { status: 'unknown' }

/**
 * ⚠️ Методы порта **асинхронные**, хотя in-memory реализация ничего не ждёт.
 *
 * Это ровно тот приём, который у стора опросов применён осознанно (`IStore`, `src/store/types.ts`:
 * «методы async, чтобы in-memory и PgStore были взаимозаменяемы»), а здесь был упущен. Синхронная
 * сигнатура — не деталь стиля: она делает вторую реализацию невозможной в принципе, потому что
 * запрос к БД синхронным не бывает. Порт был, подставить за него было нечего.
 *
 * Цена — `await` на трёх боевых вызовах (`create` ×2 в `bitrix24/trigger.ts`, `consume` в
 * `api/handlers.ts`) плюс тесты; выигрыш — снят СИГНАТУРНЫЙ барьер. Больше ничем правка не помогала:
 * вызывающие уже типизированы этим портом, и подмена реализации была прозрачна и до неё.
 *
 * ✅ **Скоуп портала (`portalId`) решён в реализации** — задаётся конструктором `PgInvitationStore`,
 * как у `PgStore`, и каждый запрос фильтрует по нему. Это было обязательным: `context` приглашения
 * несёт те же персональные данные, что и ответ (`responsibleName` помечен PII в `domain/schema.ts`).
 * До процедуры удаления данных портала приглашения **доходят** (#171): раньше рантайм писал под
 * портал `__local__`, а `deletePortal(memberId)` чистил строку с настоящим `member_id`. Теперь
 * разрыв закрыт тенант-скоупом: приглашения портала живут под его `portal_id` и стираются вместе с
 * тенантом, а данные, накопленные до установки, остаются за плейсхолдером (присвоение снято, #183).
 *
 * ⚠️ **Ключ дедупликации.** `src/store/pg.ts` планирует переключить дедуп ответов с
 * `response.invitation_token` на FK `response.invitation_id` — но `Invitation` поля `id` не несёт,
 * только `token`. Значит либо durable-ключом остаётся токен (и план в `pg.ts` правится), либо `id`
 * приезжает в схему. Заранее поле не заводим: неиспользуемая схема — ложный сигнал «сделано», и
 * таблица `invitation`, пролежавшая с первой миграции без единого писателя, это уже показала.
 */
export interface InvitationStore {
  /**
   * Создаёт приглашение со снимком контекста; возвращает запись с токеном.
   *
   * ⚠️ Частичный отказ никем не оговорён: `handleDealTrigger` создаёт приглашения в цикле, и реджект
   * на k-й итерации оставляет k−1 уже созданных, чьи токены уезжают вместе с отклонённым промисом.
   * В памяти это невидимо; в БД — осиротевшие строки со снимком ПДн, которые никому не доставят.
   * Закрывается идемпотентностью `create` по внешнему ключу — она всё равно нужна для #138.
   */
  create(input: InvitationCreate, now: Date): Promise<Invitation>
  /**
   * Чтение без расходования (предпросмотр анкеты по ссылке). Возвращает только
   * ЖИВЫЕ pending-приглашения; использованные/протухшие → `undefined` (приватность:
   * CRM-снимок израсходованного токена наружу не отдаём).
   *
   * ⚠️ Боевой вызывающий — `api.invitationCheck` (предпросмотр годности ссылки до заполнения). Он
   * отдаёт наружу ТОЛЬКО годность: снимок CRM (`responsibleName` помечен PII) неаутентифицированному
   * респонденту не положен, и всё, что вернул `peek`, обязано остаться на сервере.
   * ⚠️ Забытый `await` здесь компилируется молча: форма `if (!inv) return 403` на промисе всегда
   * ложна, то есть «ссылка недействительна» не сработает никогда. `tsc` ловит только разыменование;
   * ловит это `pnpm lint` (#165) — правило заводилось ровно под этот случай.
   */
  peek(token: string, now: Date): Promise<Invitation | undefined>
  /**
   * ⚠️ **ИНВАРИАНТ ПОРТА, обязательный для любой реализации:** живой набор `peek` — НАДМНОЖЕСТВО
   * сжигаемого набора `consume`. Иначе говоря, `peek(t) === undefined` ⇒ `consume(t, *)` никогда не
   * вернёт `ok`.
   *
   * На нём держится диагностика в `submit` (#170): когда `peek` пуст, `consume` зовётся РАДИ СТАТУСА
   * — отличить «опрос пройден» от «ссылка протухла», — и это безопасно только потому, что жечь там
   * нечего. Реализация, где `peek` строже (добавили фильтр по статусу, повесили кэш, разошлись
   * условия по сроку), начнёт жечь токены прямо на пути «мёртвый токен»: обладатель утёкшей ссылки
   * погасит чужое приглашение одним POST с мусорными ответами. Молча, без падения тестов — поэтому
   * инвариант закреплён паритетным тестом (`test/pg-invitation.test.ts`), а не только этим абзацем.
   */
  /**
   * Атомарно: при совпадении пина помечает использованным и возвращает приглашение
   * (single-use). `replay` — уже использован, `mismatch` — чужой опрос/версия (токен
   * НЕ сжигается, клиент может дослать на верный опрос), `unknown` — нет/протух.
   *
   * ⚠️ «Атомарно» в in-memory держится однопоточностью Node: между проверкой и пометкой нет точки
   * прерывания. В реализации на БД так дёшево не выйдет — одноразовость обязана быть одним запросом
   * (`UPDATE … WHERE used_at IS NULL … RETURNING`; колонки появятся в миграции 0005 — у нынешней
   * таблицы `invitation` есть только `status`/`completed_at`), иначе две одновременные отправки по
   * одной ссылке пройдут обе. Записано здесь, потому что проверить это можно только в реализации.
   *
   * ⚠️ Пара `consume` + `addResponse` НЕ атомарна и этим портом атомарной быть не может: tx-параметра
   * в нём нет. Закрыто иначе (#170): `submit` гасит токен ПОСЛЕ успешной записи, а одноразовость
   * держит дедуп `uq_response_invitation_token` — он же отвечает на «этот ответ уже есть?». Отказ
   * гашения теперь ответа не теряет: он записан, а повторная отправка упирается в дедуп и получает
   * честный 409.
   *
   * ⚠️ Отсюда следствие: **`used_at` больше не гарантия одноразовости, а бухгалтерия.** Настоящий
   * якорь — ответ с этим токеном. `consume` по-прежнему нужен (гасит живую ссылку, чтобы предпросмотр
   * `peek` не отдавал снимок CRM после прохождения опроса и чистка находила отработавшее), но
   * рассчитывать на него как на единственный барьер нельзя.
   */
  consume(token: string, pin: InvitationPin, now: Date): Promise<InvitationConsume>
}

export interface MemoryInvitationStoreOptions {
  /** Окно ответа на опрос (по умолчанию 30 дней). */
  ttlMs?: number
  /** Потолок числа ЖИВЫХ приглашений в памяти (по умолчанию 100 000). */
  maxPending?: number
  idGen?: () => string
}

export class MemoryInvitationStore implements InvitationStore {
  private readonly pending = new Map<string, { inv: Invitation; exp: number }>()
  // отдельный used-Map (token → expiresAt) различает replay от unknown в окне TTL
  // от момента использования — паритет с MemoryNonceStore (образец).
  private readonly used = new Map<string, number>()
  private readonly ttlMs: number
  private readonly maxPending: number
  private readonly idGen: () => string

  constructor(opts: MemoryInvitationStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 30 * 24 * 60 * 60_000
    this.maxPending = opts.maxPending ?? 100_000
    this.idGen = opts.idGen ?? randomUUID
  }

  async create(input: InvitationCreate, now: Date): Promise<Invitation> {
    const t = now.getTime()
    this.prune(t)
    // потолок памяти: FIFO-вытеснение самого старого по ВСТАВКЕ pending (не по сроку);
    // может убрать ещё живое приглашение, но переполнение маловероятно — приглашения
    // создаёт авторизованный binding-слой на закрытии сделок, а не пользовательский флуд.
    if (this.pending.size >= this.maxPending) {
      for (const oldest of this.pending.keys()) {
        this.pending.delete(oldest)
        break
      }
    }
    // Явный токен — только у демо-засева (см. JSDoc `InvitationCreate.token`); боевым генерируем.
    const token = input.token ?? this.idGen()
    const exp = t + (input.ttlMs ?? this.ttlMs)
    const invitation: Invitation = {
      token,
      surveyKey: input.surveyKey,
      versionNo: input.versionNo,
      context: input.context,
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: new Date(exp).toISOString()
    }
    this.pending.set(token, { inv: invitation, exp })
    return invitation
  }

  async peek(token: string, now: Date): Promise<Invitation | undefined> {
    this.prune(now.getTime())
    return this.pending.get(token)?.inv
  }

  async consume(token: string, pin: InvitationPin, now: Date): Promise<InvitationConsume> {
    const t = now.getTime()
    this.prune(t)
    if (this.used.has(token)) return { status: 'replay' }
    const entry = this.pending.get(token)
    if (!entry) return { status: 'unknown' }
    if (entry.inv.surveyKey !== pin.surveyKey || entry.inv.versionNo !== pin.versionNo) {
      return { status: 'mismatch' } // чужой пин — токен не сжигаем
    }
    this.pending.delete(token)
    this.used.set(token, t + this.ttlMs) // свежий TTL от момента использования (как nonce)
    return { status: 'ok', invitation: { ...entry.inv, status: 'used' } }
  }

  /** Чистка протухших (без таймеров — детерминизм в тестах, как у nonce). */
  private prune(t: number): void {
    for (const [token, e] of this.pending) if (e.exp <= t) this.pending.delete(token)
    for (const [token, exp] of this.used) if (exp <= t) this.used.delete(token)
  }
}
