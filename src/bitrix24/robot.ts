import { z } from 'zod'
import { verifyApplicationToken, dealToCrmContext } from './deal-event'
import {
  dealIdFromDocumentId, handleDealTrigger,
  type IssueInvitation, type TriggerResult, type TriggerTenantResolver
} from './trigger'

/**
 * Оркестрация робота автоматизации «Запустить опрос» (#122) — ЯДРО-рантайм, без HTTP/портала.
 *
 * **Зачем отдельный путь рядом с `event.bind`:** робот встаёт в автоматизацию стадии и вызывается ровно
 * НА ВХОДЕ в неё — то есть даёт ровно ту семантику «сделка дошла до стадии», которой нет у события
 * `ONCRMDEALUPDATE` (оно приходит на любое изменение). Поэтому здесь НЕ нужна проверка истории стадий
 * (`stage-transition.ts`), которой обвешан событийный путь.
 *
 * **Почему не заменяет событие:** робот доступен не на всех тарифах (bizproc), а `event.bind` работает
 * везде. Оба пути ведут в один `handleDealTrigger`; какой использовать — выбирает оператор в настройках.
 *
 * Порядок гейтов тот же, что в `deal-update.ts`: недоверенный POST → мягкий парс → сверка
 * `application_token` (constant-time) → **только потом** догрузка сделки токеном ПОРТАЛА. I/O инжектируется.
 */

/**
 * ⚠️ Wire-формат: Bitrix шлёт робота как **form-urlencoded в bracket-нотации**, поэтому после
 * `parseBracketForm` массив приходит НЕ массивом, а объектом с числовыми ключами:
 * `document_id[0]=crm&document_id[1]=…` → `{ '0': 'crm', '1': … }`. Схема, ждущая `z.array`, отвергла бы
 * реальный POST — и робот молча не работал бы в бою (ровно такой тихий no-op уже ловили на `event.bind`).
 * Поэтому нормализуем обе формы к массиву строк по возрастанию числового ключа.
 */
function toStringArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.every((x) => typeof x === 'string') ? (v as string[]) : undefined
  if (v && typeof v === 'object') {
    const raw = Object.entries(v as Record<string, unknown>)
    // Кап на число ключей — до сверки токена мы разбираем недоверенное тело; длинный список
    // сортировать незачем (реальный document_id — 3 элемента).
    if (raw.length === 0 || raw.length > 20) return undefined
    const entries = raw.map(([k, val]) => [Number(k), val] as const).sort(([a], [b]) => a - b)
    // Симметрично ветке массива: любой непригодный элемент → отказ целиком, а не тихое выбрасывание
    // (иначе `{0:'crm',1:'DEAL_759',2:99}` дало бы усечённый путь и не тот элемент id).
    if (!entries.every(([k, val]) => Number.isInteger(k) && k >= 0 && typeof val === 'string')) return undefined
    return entries.map(([, val]) => val as string)
  }
  return undefined
}

/**
 * Полезная нагрузка робота. `document_id` — `['crm','CCrmDocumentDeal','DEAL_759']` (после нормализации
 * выше). Схема мягкая: лишние поля (`code`, `event_token`, `properties`) не мешают.
 */
// Капы длины зеркалят схему событий (`deal-event.ts`): тело недоверенное и разбирается ДО сверки токена,
// поэтому многомегабайтный `member_id` не должен уезжать в SQL-параметр и в лог.
const robotEventSchema = z.object({
  document_id: z.preprocess(toStringArray, z.array(z.string().max(200)).min(1).max(10)),
  /**
   * Момент срабатывания по часам ПОРТАЛА (epoch-секунды; приходит строкой). Раньше поле просто
   * игнорировалось — теперь из него строится ключ «перехода» для маркера дела
   * ([#175](https://github.com/bx-shef/polls/issues/175), см. {@link robotTransition}).
   *
   * ⚠️ Тип — `unknown`, и это НЕ лень. Сперва здесь стоял `z.union([z.string().max(20), z.number()])`,
   * и он превращал необязательное поле в рубильник: значение не той формы (микровремя из 24 знаков,
   * ISO-строка из 25, bracket-форма `ts[0]=…` → объект) валило `safeParse` ВСЕГО события, то есть
   * робот замолкал на всех порталах с единственной строкой `b24_robot_ignored reason=parse`. А форма
   * `ts` вживую не сверена — это прямо записано в процессе. Разбор и все капы живут в
   * {@link robotTransition}, где негодное значение стоит фолбэка на свои часы, а не всей доставки.
   */
  ts: z.unknown(),
  auth: z.object({
    member_id: z.string().min(1).max(200),
    application_token: z.string().min(1).max(253)
  })
})
export type RobotEvent = z.infer<typeof robotEventSchema>

/** Безопасно распарсить недоверенный POST робота → `RobotEvent` или `null` (мусор/неполнота). */
export function parseRobotEvent(raw: unknown): RobotEvent | null {
  const r = robotEventSchema.safeParse(raw)
  return r.success ? r.data : null
}

export type RobotOutcome =
  /**
   * Не наш/битый POST, `document_id` не про сделку либо портал исчез между сверкой токена и выбором
   * стора (`tenant`) — отвечаем 200, ничего не делаем.
   */
  | { kind: 'ignored'; reason: 'parse' | 'not_deal' | 'tenant' }
  /** `application_token` не сошёлся либо портал не установлен — ничего не триггерим. */
  | { kind: 'forged'; reason: 'unknown_portal' | 'token_mismatch'; memberId: string }
  /**
   * Верифицировано и отработано. Три числа, а не одно: `results.length === 0` теперь означает ЧЕТЫРЕ
   * разные вещи — стадия не триггерит ни одного опроса, дедуп отсёк («уже приглашали»), выписка
   * отвалилась, приглашение недоставляемо (`makeInviteIssue` вернул `undefined`). Событийный путь эти
   * исходы разводит с самого начала; робот сводил их в `invitations: 0`, и единственный
   * запланированный живой прогон ([#122](https://github.com/bx-shef/polls/issues/122)) не отличил бы
   * «нечего было делать» от «не смогли».
   */
  | {
      kind: 'ok'
      results: TriggerResult[]
      deduped: string[]
      failed: string[]
      dealId: number
      /** Ключ и момент перехода — роут пишет `source`/`reason` в лог (см. {@link RobotTransition}). */
      transition: RobotTransition
    }

export interface RobotDeps {
  /** Сохранённый `application_token` портала по `member_id`; `undefined` — портал не установлен. */
  storedApplicationToken: (memberId: string) => Promise<string | undefined>
  /** Догрузка сделки токеном ПОРТАЛА. Зовётся ТОЛЬКО после успешной сверки `application_token`. */
  fetchDeal: (
    dealId: number,
    memberId: string
  ) => Promise<{ deal: Record<string, unknown>; productRows: Array<Record<string, unknown>> }>
  /**
   * Стор и приглашения ПОРТАЛА события (#49) — по подтверждённому `member_id`, ПОСЛЕ сверки
   * `application_token`. См. {@link TriggerTenantResolver}.
   */
  tenant: TriggerTenantResolver
  /**
   * Как выписывать приглашение — доставка делом в таймлайне (#175, паритет с событийным путём).
   *
   * ⚠️ Без него `handleDealTrigger` уходит в фолбэк «создать токен и всё»: приглашение появляется в
   * базе, дела нет, сотрудник ссылку не видит. Ровно это и было дефектом при `TRIGGER_MODE=robot`.
   */
  issue?: (ctx: { transition: { id?: string; at?: Date }; memberId: string }) => IssueInvitation
  /** Куда сообщить об отказе по ОДНОМУ опросу (остальные опросы этой стадии не теряем). */
  onIssueError?: (surveyKey: string, error: unknown) => void
  now?: Date
}

/**
 * Окно правдоподобия часов портала, мс.
 *
 * ⚠️ Час, а не сутки (сужено по ревью #193). Окно защищает `at` — точку отсчёта «отвечал ли клиент
 * ПОСЛЕ этого перехода»; там значимы минуты, а не дни. Часы, уехавшие на шесть часов назад, суточное
 * окно проходили и оставались «правдоподобными», то есть проверка называлась проверкой, ничего не
 * проверяя. Фолбэк (свои часы) безопасен по построению — сервер получает вызов В МОМЕНТ входа в
 * стадию, — поэтому сужение окна строго улучшает свойство и ничем не рискует.
 */
export const ROBOT_TS_SKEW_MS = 60 * 60_000

/** Кап длины строкового `ts`. Тело недоверенное и разбирается ДО сверки токена. */
const ROBOT_TS_MAX_LEN = 20

/**
 * Ключ и момент «перехода» для робота (#175).
 *
 * ⚠️ У робота НЕТ `ID` записи истории стадий — он её не спрашивает и спрашивать не должен: он
 * вызывается ровно на входе в стадию, доказывать ему нечего. Но маркер дела строится из ключа
 * перехода, и без ключа доставка не работает (`makeInviteIssue` без него молчит). Поэтому ключ
 * берётся из МОМЕНТА СРАБАТЫВАНИЯ.
 *
 * Почему не спрашиваем историю ради ключа (решение владельца, вариант «B»): это лишний REST на
 * каждое срабатывание и, главное, НЕПРОВЕРЕННОЕ допущение — успевает ли Битрикс24 записать строку
 * истории до вызова робота, вживую не сверено. Возьми мы оттуда `ID` прошлого перехода — приглашение
 * съелось бы как дубль. Цена варианта «B»: событийный путь и робот не узнаю́т дела друг друга; после
 * снятия режима `both` включить оба пути разом больше нельзя, поэтому цена платится только при смене
 * режима на живом портале.
 *
 * ⚠️ **Чего этот ключ НЕ гарантирует, и это надо знать до живого прогона.** Он различает моменты, а
 * не запуски процесса. Повтор ДОСТАВКИ того же тела (одна и та же секунда в `ts`) упрётся в маркер и
 * дубля не даст; повторное ИСПОЛНЕНИЕ активити движком bizproc принесёт новый момент — новый ключ,
 * второе дело, вторая ссылка. Поэтому «дублей нет по построению» про робота писать нельзя, и в
 * документе так и не написано. Устойчивый якорь (например `workflow_id`, если он есть в теле) даст
 * живой прогон [#122](https://github.com/bx-shef/polls/issues/122) — ради него роут логирует имена
 * полей тела на УСПЕШНОЙ ветке, а не только на отбракованной.
 *
 * ⚠️ `ts` портала проверяется на ПРАВДОПОДОБИЕ, а не просто на число: см. {@link ROBOT_TS_SKEW_MS}.
 * Разбор терпим к форме намеренно — схема события `ts` не валидирует (иначе негодное значение гасило
 * бы всю доставку), и все негодные входы обязаны деградировать ровно сюда, в свои часы.
 */
export type RobotTransition = {
  id: string
  at: Date
  /** `portal` — момент взят из `ts`; `clock` — из наших часов (тогда заполнен {@link reason}). */
  source: 'portal' | 'clock'
  /**
   * Почему взяли свои часы. Уезжает в лог отдельным полем — без него состояние «дедупа у робота нет»
   * НЕВИДИМО: функция чистая и молчит, а сводка печатает лишь число приглашений. Первый живой прогон
   * ([#122](https://github.com/bx-shef/polls/issues/122)) должен показать, работает ли ключ от
   * портала или мы всё время на своих часах.
   */
  reason?: 'missing' | 'not_number' | 'skew' | 'future'
}

export function robotTransition(ts: unknown, now: Date): RobotTransition {
  // ⚠️ Только число и короткая строка. `String(ts)` без этого сделал бы копию сколь угодно длинного
  // значения из недоверенного тела ради заведомого `NaN`.
  const seconds =
    typeof ts === 'number' ? ts
    : typeof ts === 'string' && ts.length <= ROBOT_TS_MAX_LEN ? Number(ts.trim())
    : Number.NaN
  const at = Number.isInteger(seconds) && seconds > 0 ? new Date(seconds * 1000) : undefined
  const reason: RobotTransition['reason'] | undefined =
    ts === undefined || ts === null || ts === '' ? 'missing'
    : at === undefined ? 'not_number'
    // ⚠️ Будущее клампится ВСЕГДА, а не по окну. Перехода в будущем не бывает: робота зовут в момент
    // входа в стадию. Оставь мы момент впереди — `hasResponseSince(…, at)` не вернул бы `true`
    // никогда, ветка «клиент уже ответил» умерла бы, и повторный вызов заново приглашал бы
    // ответившего клиента новым живым токеном.
    : at.getTime() > now.getTime() ? 'future'
    : now.getTime() - at.getTime() > ROBOT_TS_SKEW_MS ? 'skew'
    : undefined
  const moment = reason === undefined && at !== undefined ? at : now
  // ⚠️ Ключ и момент округляются ОДИНАКОВО. Раньше `id` резался до секунды, а `at` оставался с
  // миллисекундами: два вызова внутри одной секунды получали один ключ и разные точки отсчёта —
  // асимметрия, которая при следующей правке `hasResponseSince` стала бы источником «иногда».
  const sec = Math.floor(moment.getTime() / 1000)
  // ⚠️ Префикс `robot-` — не украшение: по маркеру дела видно, какой путь его создал, а числовой
  // ключ событийного пути с ним не совпадёт даже случайно. Двоеточий в ключе быть не должно —
  // `markerMatchesSurvey` режет маркер по ВТОРОМУ двоеточию.
  return {
    id: `robot-${sec}`,
    at: new Date(sec * 1000),
    source: reason === undefined ? 'portal' : 'clock',
    ...(reason !== undefined ? { reason } : {})
  }
}

export async function runRobotTrigger(raw: unknown, deps: RobotDeps): Promise<RobotOutcome> {
  const ev = parseRobotEvent(raw)
  if (!ev) return { kind: 'ignored', reason: 'parse' }

  const dealId = dealIdFromDocumentId(ev.document_id)
  if (!dealId) return { kind: 'ignored', reason: 'not_deal' } // робот повесили на другой тип документа

  // Анти-форджери ПЕРЕД любым исходящим вызовом (как в deal-update).
  const expected = await deps.storedApplicationToken(ev.auth.member_id)
  if (!verifyApplicationToken(ev.auth.application_token, expected ?? '')) {
    return {
      kind: 'forged',
      reason: expected === undefined ? 'unknown_portal' : 'token_mismatch',
      memberId: ev.auth.member_id
    }
  }

  // Токен сошёлся — `member_id` подтверждён, и только теперь выбирается тенант (#49).
  const tenant = await deps.tenant(ev.auth.member_id)
  if (!tenant) return { kind: 'ignored', reason: 'tenant' }

  const { deal, productRows } = await deps.fetchDeal(dealId, ev.auth.member_id)
  const context = dealToCrmContext(deal, productRows)
  // ⚠️ Проверки истории стадий тут по-прежнему НЕТ и быть не должно: робот вызывается РОВНО на входе
  // в стадию, то есть один раз на переход — доказывать нечего. Гроздь событий рождает только
  // событийный путь (`deal-update.ts`), где апдейт прилетает на каждую правку.
  //
  // ⚠️ А вот ДОСТАВКА нужна и здесь (#175): без `issue` `handleDealTrigger` уходит в фолбэк «создать
  // токен и всё» — приглашение появляется в базе, дела нет, сотрудник ссылку не видит. Ключ перехода
  // строится из момента срабатывания (`robotTransition`), а не из истории стадий.
  const transition = robotTransition(ev.ts, deps.now ?? new Date())
  const outcome = await handleDealTrigger({
    store: tenant.store,
    invitations: tenant.invitations,
    context,
    now: deps.now,
    ...(deps.issue ? { issue: deps.issue({ transition, memberId: ev.auth.member_id }) } : {}),
    ...(deps.onIssueError ? { onIssueError: deps.onIssueError } : {})
  })
  // ⚠️ `deduped`/`failed` проброшены наружу, а не отброшены: см. разбор у {@link RobotOutcome}.
  return { kind: 'ok', results: outcome.created, deduped: outcome.deduped, failed: outcome.failed, dealId, transition }
}
