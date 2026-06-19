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
 *     // getRequestIP по умолчанию отдаёт socket-IP; за reverse-proxy —
 *     // { xForwardedFor: true } ТОЛЬКО при доверенном прокси (см. server/node.ts)
 *     const r = await api.submit({ ip: getRequestIP(event) ?? '?', body: await readBody(event) })
 *     setResponseStatus(event, r.status); return r.body
 *   })
 */

/** Payload POST /api/submit = brief §8 + пин опроса/версии (мультиопросное ядро). */
const httpSubmitSchema = z
  .object({
    schema_version: z.number().int(),
    nonce: z.string().min(1).max(200),
    hp: z.string().max(200).optional(),
    invitation: z.string().min(1).max(200).optional(),
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

export interface SubmitInput {
  ip: string
  /** Разобранный JSON тела запроса (парсит адаптер). */
  body: unknown
}

export interface Api {
  session(input: SessionInput): Promise<ApiResult>
  /** Текущая версия опроса для рендера (контур A): презентация + вопросы, без invitationPolicy. */
  survey(input: SurveyInput): Promise<ApiResult>
  submit(input: SubmitInput): Promise<ApiResult>
  /** Публичный health-check (#5): 200 при живой БД, 503 при её недоступности. */
  health(): Promise<ApiResult>
}

const err = (status: number, error: string): ApiResult => ({ status, body: { ok: false, error } })

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
      if (!limiter.allow(`s:${ip}`, now())) return err(429, 'Слишком много запросов')
      const nonce = nonces.issue(now())
      if (nonce == null) return err(503, 'Сервис перегружен, попробуйте позже')
      // schema_version — клиенту для bootstrap (контракт brief §8)
      return { status: 200, body: { nonce, schema_version: SUPPORTED_SCHEMA_VERSION } }
    },

    async survey({ ip, surveyKey }: SurveyInput): Promise<ApiResult> {
      // GET-чтение: отдельный бюджет rate-limit (анти-перебор surveyKey).
      if (!limiter.allow(`sv:${ip}`, now())) return err(429, 'Слишком много запросов')
      const key = surveyKeySchema.safeParse(surveyKey)
      if (!key.success) return err(400, 'Некорректный ключ опроса')
      try {
        const version = await store.currentVersion(key.data)
        if (!version) return err(404, 'Опрос не найден')
        return { status: 200, body: { ok: true, version: toPublicVersion(version), schema_version: SUPPORTED_SCHEMA_VERSION } }
      } catch (e) {
        onError(e)
        return err(500, 'Внутренняя ошибка, попробуйте позже')
      }
    },

    async submit({ ip, body }: SubmitInput): Promise<ApiResult> {
      if (honeypotTripped(body)) return err(400, 'Отклонено')
      if (!limiter.allow(`p:${ip}`, now())) return err(429, 'Слишком много запросов')

      const parsed = httpSubmitSchema.safeParse(body)
      if (!parsed.success) return err(400, 'Некорректный запрос')
      const p = parsed.data
      if (p.schema_version !== SUPPORTED_SCHEMA_VERSION) {
        return err(400, `Неподдерживаемая версия схемы: ${p.schema_version}`)
      }

      const nonceState = nonces.consume(p.nonce, now())
      if (nonceState === 'replay') return err(409, 'Ответ уже был отправлен')
      if (nonceState === 'unknown') return err(403, 'Сессия устарела, обновите страницу')

      try {
        const version = await store.getVersion(p.surveyKey, p.versionNo)
        if (!version) return err(404, 'Опрос или версия не найдены')

        const { answers, errors } = buildResponseAnswers(version.questions, p.answers)
        if (Object.keys(errors).length > 0) return { status: 422, body: { ok: false, errors } }

        // CRM-снимок из приглашения (#3). Расходуем ПОСЛЕ валидации ответов — чтобы
        // 422 не сжигал неповторимое приглашение (в отличие от nonce, который
        // переиздаётся через /api/session). Нет токена → context пуст (back-compat).
        let context: CrmContext = {}
        if (p.invitation != null) {
          // pin-aware consume: чужой опрос/версия → 409 БЕЗ расхода токена (не сжигаем
          // приглашение при несовпадении пина — анти-DoS на утёкший токен).
          const inv = invitations.consume(p.invitation, { surveyKey: p.surveyKey, versionNo: p.versionNo }, now())
          if (inv.status === 'replay') return err(409, 'Приглашение уже использовано')
          if (inv.status === 'mismatch') return err(409, 'Приглашение не соответствует опросу или версии')
          if (inv.status === 'unknown') return err(403, 'Приглашение недействительно или истекло')
          context = inv.invitation.context
        }

        await store.addResponse({
          id: idGen(),
          surveyKey: version.surveyKey,
          versionNo: version.versionNo,
          submittedAt: now().toISOString(), // только сервер; клиентское поле игнорируется (#4)
          context, // снимок из приглашения (#3) либо {} без токена
          answers,
          // токен → durable-якорь идемпотентности (стор дедуплицирует по нему, #3/#4)
          ...(p.invitation != null ? { invitationToken: p.invitation } : {})
        })
        return { status: 200, body: { ok: true } }
      } catch (e) {
        // store может отказать (гонка версий, недоступность БД) — без деталей наружу
        onError(e)
        return err(500, 'Внутренняя ошибка, попробуйте позже')
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
