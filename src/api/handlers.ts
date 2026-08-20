import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { buildResponseAnswers } from '../domain/answers'
import { rawAnswerSchema, type CompiledVersion, type CrmContext, type PublicVersion } from '../domain/schema'
import type { IStore } from '../store/types'
import { errInfo, nullLogger, type Logger } from '../obs/logger'
import { MemoryNonceStore, type NonceStore } from './nonce'
import { SlidingWindowLimiter, type RateLimiter } from './ratelimit'
import { MemoryInvitationStore, type InvitationStore } from './invitation'

/**
 * HTTP-хендлеры опроса (контур A) — framework-agnostic, как и всё ядро:
 * чистые функции «вход → { status, body }» с инжектируемыми зависимостями
 * (store/nonce/limiter/часы). Нет привязки к Nitro/Express — адаптер задаёт
 * рантайм (см. src/server/node.ts; Nitro-обёртка фазы связки — в JSDoc ниже).
 *
 * Конвейер POST /api/submit (порядок — по ISSUE #4 и brief §8):
 *   1. honeypot (`hp` непустой → 400, generic-ответ — боту незачем знать причину)
 *   2. rate-limit по IP → 429
 *   3. форма payload (zod) и schema_version → 400
 *   4. nonce: повтор → 409, неизвестный/протухший → 403
 *   5. версия опроса → 404 (nonce к этому моменту уже потрачен — НАМЕРЕННО:
 *      анти-перебор surveyKey/versionNo; UX: после 404/422 клиент запрашивает
 *      новый nonce через GET /api/session)
 *   6. валидация ответов ядром (buildResponseAnswers) → 422 { errors }
 *   7. приглашение (#3): токен `invitation` (если есть) сверяется/расходуется ПОСЛЕ
 *      422 — replay → 409, чужой пин (surveyKey/versionNo) → 409 БЕЗ расхода токена,
 *      неизвестный/протухший → 403; CRM-снимок берётся только на успехе
 *   8. запись: id и submittedAt ставит СЕРВЕР (клиентские значения не принимаются),
 *      context = снимок из приглашения (#3) либо {} без токена → 200 { ok: true }
 *
 * Nitro-адаптер (фаза связки) — тонкая обёртка:
 *   export default defineEventHandler(async (event) => {
 *     // Адрес клиента — ТОЛЬКО через единую точку `requestIp(event)` (server/utils/api.ts):
 *     // `getRequestIP` отдаёт адрес прокси (один на всех), а `{ xForwardedFor: true }` берёт
 *     // адрес, который написал сам отправитель. Оба варианта ломают лимитер молча — см. api/client-ip.
 *     const r = await api.submit({ ip: getRequestIP(event) ?? '?', body: await readBody(event) })
 *     setResponseStatus(event, r.status); return r.body
 *   })
 */

/**
 * Форма токена приглашения — ОДНА на оба входа (`submit` и проверка ссылки).
 *
 * ⚠️ Пока границы было две (у `submit` — эта, у проверки — никакой), один и тот же вход получал два
 * разных диагноза: токен на 5000 символов доезжал до стора и получал «срок ссылки истёк», а тот же
 * токен в `submit` — «проверьте заполнение». Стор при этом in-memory, то есть безвредно; но
 * durable-стор (#4) отправит это в параметр SQL-запроса.
 */
export const invitationTokenSchema = z.string().min(1).max(200)

/** Payload POST /api/submit = brief §8 + пин опроса/версии (мультиопросное ядро). */
const httpSubmitSchema = z
  .object({
    schema_version: z.number().int(),
    nonce: z.string().min(1).max(200),
    hp: z.string().max(200).optional(),
    invitation: invitationTokenSchema.optional(),
    surveyKey: z.string().min(1).max(200),
    versionNo: z.number().int().positive(),
    answers: z.record(z.string().max(200), rawAnswerSchema)
  })
  .refine((s) => Object.keys(s.answers).length <= 200, { message: 'Слишком много ответов в payload' })

export const SUPPORTED_SCHEMA_VERSION = 1

export interface ApiDeps {
  store: IStore
  nonces?: NonceStore
  limiter?: RateLimiter
  /** Стор приглашений (#3): резолвит токен → снимок CRM-контекста. Default in-memory. */
  invitations?: InvitationStore
  /** Часы сервера (инжектируются в тестах). submittedAt ставится только отсюда. */
  now?: () => Date
  idGen?: () => string
  /** Структурный логгер (#5). Default `nullLogger` (тишина без сайд-эффектов). */
  logger?: Logger
  /**
   * Хук диагностики внутренних ошибок (500). Если не задан — пишет в `logger`
   * (`api_error`). Задайте, чтобы перенаправить ошибку в свой трекер.
   */
  onError?: (e: unknown) => void
  /**
   * TTL кэша `health()` в мс (default 1000). Health публичный и НЕ throttled —
   * кэш ограничивает частоту реальных `store.ping()` (анти-DoS на пул БД).
   */
  healthCacheMs?: number
}

export interface ApiResult {
  status: number
  body: Record<string, unknown>
}

export interface SessionInput {
  ip: string
}

export interface SurveyInput {
  ip: string
  surveyKey: string
}

const surveyKeySchema = z.string().min(1).max(200)

/**
 * Публичная проекция версии для контура A (GET /api/survey/:key/current):
 * презентация + вопросы из снимка, но БЕЗ `invitationPolicy` — триггер-стадии и
 * канал приглашения это внутренняя CRM-конфигурация, наружу её не отдаём.
 * Тип возврата — `Omit<…, 'invitationPolicy'>`: добавят новое чувствительное
 * поле в версию — компилятор не даст молча протечь (заставит обновить проекцию).
 */
function toPublicVersion(v: CompiledVersion): PublicVersion {
  const { invitationPolicy: _omit, ...pub } = v
  return pub
}

export interface InvitationCheckInput {
  ip: string
  surveyKey: string
  token: string
}

export interface SubmitInput {
  ip: string
  /** Разобранный JSON тела запроса (парсит адаптер). */
  body: unknown
}

export interface Api {
  session(input: SessionInput): Promise<ApiResult>
  /** Текущая версия опроса для рендера (контур A): презентация + вопросы, без invitationPolicy. */
  survey(input: SurveyInput): Promise<ApiResult>
  /**
   * Годна ли ссылка-приглашение (контур A, до заполнения). Отдаёт ТОЛЬКО годность — снимок CRM
   * наружу не уходит. Ничего не расходует: `peek`, не `consume`.
   */
  invitationCheck(input: InvitationCheckInput): Promise<ApiResult>
  submit(input: SubmitInput): Promise<ApiResult>
  /** Публичный health-check (#5): 200 при живой БД, 503 при её недоступности. */
  health(): Promise<ApiResult>
}

const err = (status: number, error: string): ApiResult => ({ status, body: { ok: false, error } })

/**
 * Тексты отказов по приглашению — в одном месте, потому что их читают ДВА входа: проверка ссылки
 * (до заполнения) и `submit` (после). Пока они лежали по месту употребления, одно и то же состояние
 * стора описывалось двумя разными фразами — «срок истёк, или опрос уже пройден» против «срок истёк
 * или она недействительна», — и человек получал разный ответ на один и тот же вопрос в зависимости
 * от того, когда спросил.
 */
const INVITATION_TEXT = {
  /** `unknown`: нет такого токена / протух / уже использован — стор эти случаи не различает. */
  dead: 'Срок ссылки истёк, или опрос по ней уже пройден. Попросите новую ссылку у менеджера.',
  /** `replay` (знает только `consume`): человек уже прошёл опрос — говорим спасибо, а не «просите новую». */
  replay: 'Эта ссылка уже использована — опрос пройден. Спасибо!',
  mismatch: 'Ссылка не подходит к этому опросу. Откройте опрос по правильной ссылке.',
  republished: 'Опрос обновился с тех пор, как выписали ссылку. Попросите новую ссылку у менеджера.',
  malformed: 'Ссылка повреждена — код приглашения в ней прочитать не удалось. Попросите новую ссылку у менеджера.'
} as const

/** honeypot читаем до zod: боту — generic 400 без подсказок о форме payload. */
function honeypotTripped(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false
  const hp = (body as Record<string, unknown>)['hp']
  return typeof hp === 'string' && hp.trim() !== ''
}

export function createApi(deps: ApiDeps): Api {
  const store = deps.store
  const nonces = deps.nonces ?? new MemoryNonceStore()
  const limiter = deps.limiter ?? new SlidingWindowLimiter({ limit: 10, windowMs: 60_000 })
  const invitations = deps.invitations ?? new MemoryInvitationStore()
  const now = deps.now ?? ((): Date => new Date())
  const idGen = deps.idGen ?? randomUUID
  const logger = deps.logger ?? nullLogger
  const onError = deps.onError ?? ((e: unknown): void => logger.error('api_error', { err: errInfo(e) }))
  const healthCacheMs = deps.healthCacheMs ?? 1000
  let healthCache: { atMs: number; result: ApiResult } | null = null

  return {
    async session({ ip }: SessionInput): Promise<ApiResult> {
      if (!limiter.allow(`s:${ip}`, now())) return err(429, 'Слишком много запросов. Подождите немного и попробуйте снова.')
      const nonce = nonces.issue(now())
      if (nonce == null) return err(503, 'Сервис сейчас перегружен. Попробуйте через минуту.')
      // schema_version — клиенту для bootstrap (контракт brief §8)
      return { status: 200, body: { nonce, schema_version: SUPPORTED_SCHEMA_VERSION } }
    },

    async survey({ ip, surveyKey }: SurveyInput): Promise<ApiResult> {
      // GET-чтение: отдельный бюджет rate-limit (анти-перебор surveyKey).
      if (!limiter.allow(`sv:${ip}`, now())) return err(429, 'Слишком много запросов. Подождите немного и попробуйте снова.')
      const key = surveyKeySchema.safeParse(surveyKey)
      if (!key.success) return err(400, 'Неверный адрес опроса. Проверьте ссылку.')
      try {
        const version = await store.currentVersion(key.data)
        if (!version) return err(404, 'Опрос не найден. Возможно, ссылка устарела — попросите новую.')
        return { status: 200, body: { ok: true, version: toPublicVersion(version), schema_version: SUPPORTED_SCHEMA_VERSION } }
      } catch (e) {
        onError(e)
        return err(500, 'Не удалось загрузить опрос. Обновите страницу или попробуйте позже.')
      }
    },

    /**
     * Годна ли ссылка-приглашение — ДО того, как человек заполнил анкету.
     *
     * ⚠️ Смысл роута ровно в моменте. Без него негодная ссылка обнаруживается на «Отправить», то
     * есть после того, как человек прошёл весь опрос: работа сделана, ответ не принят. Здесь та же
     * проверка выполняется на открытии страницы и ничего не расходует.
     *
     * ⚠️ Наружу уходит ТОЛЬКО годность. `peek` отдаёт `Invitation` со снимком CRM (`responsibleName`
     * помечен PII в схеме) — по этому роуту ходит неаутентифицированный респондент, и снимок ему не
     * положен. Отсюда же отдельный роут вместо параметра к `survey`: у того ответ кэшируется по ETag,
     * посчитанному БЕЗ токена, и токен-зависимое тело отравило бы общий кэш.
     *
     * Свой бюджет лимитера: роут позволяет проверять токены перебором, не оставляя следов в данных.
     *
     * ⚠️ Но бюджет этот НЕ «на респондента», и обещать обратное нельзя (замерено на ревью). Страница
     * зовёт проверку на SSR, у внутреннего вызова сокета нет, `clientIp` честно отдаёт `unknown` —
     * значит все SSR-проверки считаются одним ключом `i:unknown`, а по своему ключу идут только
     * прямые обращения к API. Отсюда и потолок остаётся высоким: он общий на весь сервис, и
     * «строгий» потолок здесь означал бы кап на число открытий страницы, а не на перебор. Перебор
     * при этом всё равно безнадёжен — токен `randomUUID` (122 бита). Пер-респондентная гранулярность
     * на SSR-пути упирается в доверенный прокси (#6) и делается там, а не тут.
     */
    async invitationCheck({ ip, surveyKey, token }: InvitationCheckInput): Promise<ApiResult> {
      if (!limiter.allow(`i:${ip}`, now())) return err(429, 'Слишком много запросов. Подождите немного и попробуйте снова.')
      const key = surveyKeySchema.safeParse(surveyKey)
      if (!key.success) return err(400, 'Неверный адрес опроса. Проверьте ссылку.')
      // Форма токена — до похода в стор, и та же, что у `submit` (один вход → один диагноз).
      if (!invitationTokenSchema.safeParse(token).success) return err(400, INVITATION_TEXT.malformed)
      try {
        const invitation = await invitations.peek(token, now())
        // `peek` не различает «использована» и «протухла» (оба → `undefined`), и различать их здесь
        // нечем. Поэтому текст покрывает оба случая честно, а не выбирает один наугад.
        //
        // ⚠️ Сюда же сведена ветка «токен от ДРУГОГО опроса», хотя точный текст для неё есть
        // (`INVITATION_TEXT.mismatch`, им отвечает `submit`). Причина — ревью безопасности: отдельный
        // ответ на этой ветке сообщает, что токен СУЩЕСТВУЕТ, просто не от этого опроса, а сказать
        // это человеку по нашей ссылке невозможно: `deal-invite` собирает `/s/<surveyKey>?token=…`
        // из одной записи через `surveyPath`, ключ и токен всегда согласованы. То есть текст
        // адресован никому, а бит существования отдаёт всем.
        if (!invitation || invitation.surveyKey !== key.data) return err(403, INVITATION_TEXT.dead)
        // Приглашение пинится на версию, и `submit` отвергает чужую (`mismatch`). Значит опрос,
        // переизданный после выписки ссылки, делает её негодной — и узнать об этом человек обязан
        // ЗДЕСЬ, а не после заполнения. Эта ветка достижима штатно (переиздали опрос между выпиской
        // и переходом), поэтому её текст остаётся отдельным.
        const version = await store.currentVersion(key.data)
        if (!version) return err(404, 'Опрос не найден. Возможно, ссылка устарела — попросите новую.')
        if (version.versionNo !== invitation.versionNo) return err(409, INVITATION_TEXT.republished)
        return { status: 200, body: { ok: true } }
      } catch (e) {
        onError(e)
        // ⚠️ Клиент на 5xx опрос НЕ закрывает (предпросмотр — удобство, гейт — `consume` на
        // отправке). Текст остаётся на случай прямого обращения к роуту.
        return err(500, 'Не удалось проверить ссылку. Попробуйте позже.')
      }
    },

    async submit({ ip, body }: SubmitInput): Promise<ApiResult> {
      if (honeypotTripped(body)) return err(400, 'Не удалось отправить ответ.')
      if (!limiter.allow(`p:${ip}`, now())) return err(429, 'Слишком много запросов. Подождите немного и попробуйте снова.')

      const parsed = httpSubmitSchema.safeParse(body)
      if (!parsed.success) return err(400, 'Ответ не отправлен: проверьте заполнение и попробуйте снова.')
      const p = parsed.data
      if (p.schema_version !== SUPPORTED_SCHEMA_VERSION) {
        return err(400, 'Страница опроса устарела. Обновите её и заполните заново.')
      }

      const nonceState = nonces.consume(p.nonce, now())
      if (nonceState === 'replay') return err(409, 'Этот ответ уже отправлен — повторять не нужно.')
      if (nonceState === 'unknown') return err(403, 'Страница устарела. Обновите её и заполните опрос заново.')

      try {
        const version = await store.getVersion(p.surveyKey, p.versionNo)
        if (!version) return err(404, 'Опрос не найден или обновился. Обновите страницу и заполните заново.')

        const { answers, errors } = buildResponseAnswers(version.questions, p.answers)
        // 422 — единственный отказ, который отвечал ТОЛЬКО машинными `errors`, без строки для
        // человека. Клиент показывал на него общий фолбэк «проверьте подключение» — совет, прямо
        // уводящий в сторону: связь как раз в порядке, не сходятся ответы. Поэтому рядом с `errors`
        // (их разбирает форма — подсветить конкретные вопросы) идёт и `error` для показа.
        if (Object.keys(errors).length > 0) {
          return {
            status: 422,
            body: { ok: false, error: 'Ответ не отправлен: проверьте заполнение и попробуйте снова.', errors }
          }
        }

        /**
         * Порядок: **прочитать приглашение → записать ответ → погасить токен** (#170).
         *
         * ⚠️ Раньше было наоборот — `consume` шёл первым. Пока приглашения жили в памяти, отказ
         * записи после расхода лечился рестартом: токен возвращался к жизни вместе с пустым стором.
         * С durable-стором нет — ссылка мертва навсегда, ответа нет, человек читает «вы уже прошли
         * опрос», а переиздать ссылку может только менеджер. Это был единственный способ
         * безвозвратно потерять уже заполненную анкету.
         *
         * ⚠️ Честный 409 при этом сохранён — он держится на `stored` от `addResponse`, а не на
         * порядке. Простая перестановка без этого признака ломала более важное свойство: двое по
         * одной ссылке получали ОБА 200, потому что второй ответ молча съедался дедупом по токену, и
         * человек, чьи ответы выброшены, об этом не узнавал. Молчаливый приём хуже редкой потери.
         *
         * Что где отказывает:
         *  - отказ на `peek`    → ссылка цела, ответа нет (как и раньше);
         *  - отказ на записи    → ссылка ЦЕЛА, человек может отправить снова;
         *  - отказ на `consume` → ответ УЖЕ записан; повтор самозаживает: `addResponse` вернёт
         *    `stored: false`, и человек получит 409 «опрос пройден» — что и есть правда.
         *
         * Пин (опрос+версия) сверяется ДО записи: чужой опрос/версия → 409 без расхода токена
         * (анти-DoS на утёкший токен). 422 по ответам приглашение тоже не сжигает — валидация выше.
         */
        let context: CrmContext = {}
        if (p.invitation != null) {
          const inv = await invitations.peek(p.invitation, now())
          if (!inv) {
            // `peek` не различает «нет такого токена» / «протух» / «уже использован» — все три дают
            // `undefined`. А человеку разница видна: прошедший опрос должен услышать «спасибо, опрос
            // пройден», а не «попросите новую ссылку у менеджера». Диагноз даёт `consume` — здесь он
            // НИЧЕГО не расходует по построению: сюда мы попали только потому, что живого
            // приглашения нет, а погасить уже погашенное (или несуществующее) нечем.
            // ⚠️ Отказ самого диагноза НЕ должен менять ответ: решение («приглашение не годно») уже
            // принято выше, диагноз влияет только на ТЕКСТ. Без этого `catch` лежащий стор превращал
            // протухшую ссылку в 500 «попробуйте ещё раз» — совет, который не может сработать в
            // принципе, и каждая попытка стоила бы ещё одного запроса к БД.
            const diag = await invitations
              .consume(p.invitation, { surveyKey: p.surveyKey, versionNo: p.versionNo }, now())
              .catch((e: unknown) => { onError(e); return { status: 'unknown' } as const })
            // Явный разбор всех статусов, а не тернарник: `mismatch` сегодня сюда не доходит (строка,
            // живая для `consume`, была бы отдана `peek`), но недостижимость держится на инварианте
            // двух методов, а не на типах. `switch` заставит компилятор обновить ветку, если в
            // `InvitationConsume` появится четвёртый статус.
            switch (diag.status) {
              case 'replay': return err(409, INVITATION_TEXT.replay)
              case 'mismatch': return err(409, INVITATION_TEXT.mismatch)
              default: return err(403, INVITATION_TEXT.dead)
            }
          }
          if (inv.surveyKey !== p.surveyKey || inv.versionNo !== p.versionNo) {
            return err(409, INVITATION_TEXT.mismatch)
          }
          context = inv.context
        }

        const responseId = idGen()
        const { stored } = await store.addResponse({
          id: responseId,
          surveyKey: version.surveyKey,
          versionNo: version.versionNo,
          submittedAt: now().toISOString(), // только сервер; клиентское поле игнорируется (#4)
          context, // снимок из приглашения (#3) либо {} без токена
          answers,
          // токен → durable-якорь идемпотентности (стор дедуплицирует по нему, #3/#4)
          ...(p.invitation != null ? { invitationToken: p.invitation } : {})
        })

        /**
         * Гасим ссылку ПОСЛЕ записи — и в обеих ветках, а не только на успешной.
         *
         * ⚠️ Ветка `stored === false` («ответ по этой ссылке уже записан») — это ровно то состояние,
         * ради которого весь PR: предыдущая попытка записала ответ, но не догасила токен. Если
         * выйти отсюда сразу с 409, состояние «ответ есть, ссылка жива» становится ТЕРМИНАЛЬНЫМ:
         * единственный код, который гасит токен, до него больше не доходит. А значит предпросмотр
         * `peek` бессрочно отдаёт снимок CRM, `invitationCheck` отвечает «ссылка годна» — человек с
         * пересланной ссылкой заполняет анкету и узнаёт правду только на «Отправить», — и чистка
         * ПДн меряет срок от `expires_at`, а не от прохождения опроса.
         *
         * Отказ гашения ответа не теряет: он записан, а повторная отправка упрётся в дедуп и снова
         * попадёт сюда же. Поэтому ошибку не пробрасываем — иначе человек увидел бы «не
         * отправилось» по уже принятому ответу и заполнял бы заново.
         */
        if (p.invitation != null) {
          // ⚠️ Ошибку НЕ гоним через `onError`: это хук внутренних отказов, по умолчанию пишущий
          // `api_error` уровня error. Запрос при этом отвечает 200 — и всё, что считает `api_error`
          // за пятисотку (алерт, дашборд), получало бы ложный сигнал отказа на успешном ответе.
          const burnt = await invitations
            .consume(p.invitation, { surveyKey: p.surveyKey, versionNo: p.versionNo }, now())
            .catch((e: unknown) => ({ status: 'error', err: errInfo(e) }) as const)
          // `replay` — ссылка уже была погашена прошлой попыткой: это норма, а не расхождение.
          if (burnt.status !== 'ok' && burnt.status !== 'replay') {
            // Ссылка осталась живой, а ответ записан. Поля — чтобы расхождение можно было найти и
            // догасить руками; токен в лог не кладём (он и есть секрет-ссылка).
            logger.warn('invitation_burn_failed', {
              status: burnt.status,
              responseId,
              surveyKey: p.surveyKey,
              versionNo: p.versionNo,
              ...('err' in burnt ? { err: burnt.err } : {})
            })
          }
        }

        // Дедуп по токену сказал «такой ответ уже есть» — значит по этой ссылке опрос пройден.
        // Отвечаем тем же 409, каким раньше отвечал `consume` на `replay`.
        // ⚠️ Сужено до пути С приглашением: без токена дедупа нет ни в одной реализации, и
        // `stored: false` тут означал бы поломку стора, а не повтор. Отдать на неё «ссылка уже
        // использована» значило бы молча потерять публичный ответ под неверным текстом.
        if (!stored) {
          if (p.invitation != null) return err(409, INVITATION_TEXT.replay)
          onError(new Error('addResponse вернул stored:false для ответа без приглашения'))
          return err(500, 'Не удалось сохранить ответ. Попробуйте ещё раз позже.')
        }

        return { status: 200, body: { ok: true } }
      } catch (e) {
        // store может отказать (гонка версий, недоступность БД) — без деталей наружу
        onError(e)
        return err(500, 'Не удалось сохранить ответ. Попробуйте ещё раз позже.')
      }
    },

    async health(): Promise<ApiResult> {
      // Кэш на healthCacheMs: health публичный и НЕ throttled (оркестратор/прокси
      // опрашивают часто) — иначе флуд /api/health долбил бы пул БД (DoS-вектор).
      const nowMs = now().getTime()
      if (healthCache && nowMs - healthCache.atMs < healthCacheMs) return healthCache.result
      const ts = now().toISOString()
      let result: ApiResult
      try {
        await store.ping()
        result = { status: 200, body: { ok: true, ts } }
      } catch (e) {
        // Деталей наружу не даём: тело health = { ok, ts } (намеренно без `error`);
        // диагностика — в лог.
        logger.error('health_ping_failed', { err: errInfo(e) })
        result = { status: 503, body: { ok: false, ts } }
      }
      healthCache = { atMs: nowMs, result }
      return result
    }
  }
}
