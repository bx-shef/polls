import { readPortalGrant, type PortalGrant } from './grant'

/**
 * Verify an ONAPPINSTALL payload and decide what to persist. Pure over an injected read.
 *
 * Слой решения отделён от HTTP по образцу `client-bank-alfa-by`
 * (`server/utils/b24EventsHandler.ts::processB24Event`): там роут — тонкий адаптер, а весь
 * разбор, проверка подлинности и выбор действия живут в функции, которую можно вызвать
 * из теста без поднятого сервера.
 *
 * ⚠ Сначала я обосновывал это тем, что роут Nitro «физически нельзя импортировать в тест»:
 * он держится на автоимпорте `defineEventHandler`. Ревью это опровергло — достаточно
 * подставить два глобальных имени, и роут импортируется (`tests/unit/api-catch-all.test.ts`
 * так и делает). Настоящая причина проще и от этого не слабее: решение, живущее в роуте,
 * проверяется только вместе с HTTP, базой и сетью, то есть дорого и редко. Здесь оно
 * проверяется вызовом функции — и проверяется ровно то, ради чего написан весь модуль.
 */

/** Что вернула переавторизация. Тип объявлен в домене, реализация — в `server/b24/oauth.ts`. */
export interface Reauthorization {
  /** Идентификатор портала, посчитанный сервером авторизации, а не присланный нам. */
  memberId: string
  accessToken: string
  refreshToken: string
  expiresIn: number
  scope: string[]
  /** Адрес REST портала по версии сервера авторизации. Клиент не может его продиктовать. */
  clientEndpoint: string
}

export type ReauthOutcome
  = | { ok: true, tokens: Reauthorization }
  /** `rejected` — грант поддельный или мёртвый; `unavailable` — мы сейчас не можем это выяснить. */
    | { ok: false, kind: 'rejected' | 'unavailable', code: string }

export interface InstallDeps {
  reauthorize: (refreshToken: string) => Promise<ReauthOutcome>
}

/** Что записать по итогам подтверждённой установки. */
export interface RegisterPortal {
  type: 'register'
  /** Из переавторизации, а не из события: у события это поле контролирует отправитель. */
  memberId: string
  domain: string
  accessToken: string
  refreshToken: string
  /**
   * Приходит только в событии установки: у сервера авторизации такого поля нет.
   * По нему сверяется каждое последующее событие портала, поэтому сохранить обязаны.
   */
  applicationToken: string
  expiresInSeconds: number
  scope: string[]
}

export interface InstallDecision {
  status: 200 | 400 | 403 | 503
  /** Код причины для журнала. Наружу не отдаётся: подробный отказ подсказывает подбирающему. */
  reason: string
  action?: RegisterPortal
}

/**
 * Код события в верхнем регистре: портал пишет `OnAppInstall`, документация — `ONAPPINSTALL`.
 *
 * Живёт здесь, а не в `server/b24/`, хотя пришёл оттуда вместе с разбором тела. Причина
 * не стилистическая: доменный слой не должен зависеть от интеграционного, а единственный
 * потребитель этой функции — решение об установке. У соседа обе функции лежат рядом,
 * потому что у него нет такого разделения.
 */
function eventCode(payload: unknown): string {
  const code = (payload as { event?: unknown } | null)?.event
  return typeof code === 'string' ? code.toUpperCase() : ''
}

/**
 * Хост из адреса REST: `https://shef.bitrix24.ru/rest/` → `shef.bitrix24.ru`.
 * Приводить регистр не нужно: `URL.hostname` делает это сам по спецификации.
 */
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).hostname
  }
  catch {
    return ''
  }
}

/**
 * Решить, что делать с событием установки.
 *
 * Порядок проверок — от дешёвых к дорогим, и это не стиль: до переавторизации не делается
 * ни одного исходящего запроса, иначе поток мусорных POST превратился бы в поток наших
 * обращений к серверу авторизации, за который блокируют приложение целиком.
 */
export async function decideInstall(payload: unknown, deps: InstallDeps): Promise<InstallDecision> {
  if (eventCode(payload) !== 'ONAPPINSTALL') {
    return { status: 400, reason: 'unexpected-event' }
  }

  const parsed = readPortalGrant((payload as { auth?: unknown } | null)?.auth)
  if (!parsed.ok) {
    return { status: 400, reason: parsed.reason }
  }
  const grant: PortalGrant = parsed.grant

  const outcome = await deps.reauthorize(grant.refreshToken)
  if (!outcome.ok) {
    // Отказ гранта и невозможность его проверить лечатся по-разному: первое повторять
    // бессмысленно, второе — единственное правильное действие.
    return { status: outcome.kind === 'rejected' ? 403 : 503, reason: outcome.code }
  }
  const tokens = outcome.tokens

  // Вот ради этой строки всё и затевалось. Нормализация регистра — потому что поводов
  // отказать живой установке и так хватает.
  if (tokens.memberId.toLowerCase() !== grant.memberId.toLowerCase()) {
    return { status: 403, reason: 'member-mismatch' }
  }

  // Второе бесплатное доказательство того же класса: `client_endpoint` возвращает сервер
  // авторизации, а в запросе обмена нет ни одного поля, которым его можно продиктовать.
  // Без этой сверки домен в базе остаётся тем, что прислали, — отфильтрованным только
  // по формату. Сегодня по домену никто не ищет портал; тот, кто начнёт, унаследовал бы
  // дыру молча.
  const endpointHost = hostOf(tokens.clientEndpoint)
  if (endpointHost !== '' && endpointHost !== grant.domain) {
    return { status: 403, reason: 'domain-mismatch' }
  }

  return {
    status: 200,
    // Пустой `client_endpoint` не отвергаем: штатно он есть, но отказать настоящей
    // установке из-за необязательного поля дороже, чем записать домен без второго
    // подтверждения. Причина уезжает в журнал именно поэтому.
    reason: endpointHost === '' ? 'installed-without-endpoint-proof' : 'installed',
    action: {
      type: 'register',
      memberId: tokens.memberId.toLowerCase(),
      // Домен берём из ПОДТВЕРЖДЁННОГО адреса, когда он есть: `client_endpoint` посчитал
      // сервер авторизации, а `auth.domain` прислал тот же, кто прислал всё остальное.
      // Пустой адрес — единственный случай, когда в базу уезжает непроверенное значение,
      // и ровно поэтому он отдельно назван в причине.
      domain: endpointHost === '' ? grant.domain : endpointHost,
      // ⚠ Обмен ВРАЩАЕТ токен: присланный в событии `refresh_token` уже мёртв.
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      applicationToken: grant.applicationToken,
      expiresInSeconds: tokens.expiresIn,
      scope: tokens.scope.length > 0 ? tokens.scope : grant.scope,
    },
  }
}
