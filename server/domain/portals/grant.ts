import { isPortalDomain } from './zones'

/**
 * The authorization grant a portal hands us when the app is installed.
 *
 * Доменное представление: обычный объект без единого знания о том, как он приехал.
 * Разбор HTTP-тела живёт в `server/b24/`, сюда приходит уже готовая структура.
 */
export interface PortalGrant {
  domain: string
  memberId: string
  /** Единственный токен из события, который нам нужен: его меняют на подтверждённую пару. */
  refreshToken: string
  /** Постоянный токен приложения: по нему сверяются все последующие события портала. */
  applicationToken: string
  /**
   * Запасной список прав: берётся, только если сервер авторизации не вернул свой.
   *
   * Остальных полей события здесь нет намеренно. `access_token`, `expires_in`,
   * `client_endpoint` и `status` портал присылает, но читать их незачем: первые три
   * приезжают в подтверждённом виде из ответа на обмен токена, а `status` ни на что
   * не влияет — лицензию мы проверяем реактивно, по ошибке вызова. Разобранное и никем
   * не используемое поле — это не задел, а лишний повод отказать установке.
   */
  scope: string[]
}

/**
 * Почему грант отвергнут.
 *
 * Именованные причины, а не булево: они уезжают в лог и в метрику, и «не установилось»
 * без причины — это вызов в поддержку вместо строки в журнале. Текстов клиенту здесь нет
 * намеренно, их место в обработчике.
 */
export type GrantRejection
  = | 'not-an-object'
    | 'bad-domain'
    | 'missing-member-id'
    | 'missing-refresh-token'
    | 'missing-application-token'

export type GrantResult
  = | { ok: true, grant: PortalGrant }
    | { ok: false, reason: GrantRejection }

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Прочитать объект `auth` события установки в доменный грант.
 *
 * Проверяется состав, а не подлинность: подтвердить, что грант действительно от этого
 * портала, можно только переавторизацией (`server/b24/oauth.ts`). Здесь отсекается то,
 * с чем и пробовать незачем.
 */
export function readPortalGrant(auth: unknown, optional = false): GrantResult {
  if (typeof auth !== 'object' || auth === null) {
    return { ok: false, reason: 'not-an-object' }
  }

  const raw = auth as Record<string, unknown>
  const domain = text(raw.domain).toLowerCase()
  if (!isPortalDomain(domain)) return { ok: false, reason: 'bad-domain' }

  const memberId = text(raw.member_id)
  if (memberId === '') return { ok: false, reason: 'missing-member-id' }

  const refreshToken = text(raw.refresh_token)
  if (refreshToken === '') return { ok: false, reason: 'missing-refresh-token' }

  // Без него мы не сможем проверить ни одно последующее событие портала, то есть примем
  // любое. Отсутствие `application_token` — это не «поле забыли», это открытый обработчик.
  //
  // ⚠ Требуется только на пути СОБЫТИЯ. У мастера установки этого поля нет вовсе: фрейм
  // отдаёт `access_token`, `refresh_token`, `member_id` и `domain`, а `application_token`
  // приходит исключительно в событиях. См. `readFrameGrant` ниже.
  const applicationToken = text(raw.application_token)
  if (!optional && applicationToken === '') return { ok: false, reason: 'missing-application-token' }

  return {
    ok: true,
    grant: {
      domain,
      memberId,
      refreshToken,
      applicationToken,
      // Режем и по пробелу, и по запятой. Описание поля в документации ONAPPINSTALL
      // говорит «через пробел», но пример в статье про безопасность обработчиков
      // показывает `"scope": "crm,user,task"` — то есть запятую. Какой разделитель
      // приезжает на самом деле, покажет живая установка; пока принимаем оба.
      scope: text(raw.scope).split(/[\s,]+/).filter(Boolean),
    },
  }
}

/**
 * Прочитать грант, пришедший из МАСТЕРА УСТАНОВКИ, а не из события.
 *
 * ⚠ Отличие ровно одно и оно не в строгости, а в том, чего у портала нет: `application_token`
 * приходит только в событиях, во фрейме его нет ни в каком виде (`AuthData` в SDK — это
 * `access_token`, `refresh_token`, `expires`, `expires_in`, `domain`, `member_id`, и всё).
 * Требовать поле, которого источник не присылает, значит сделать мастер неработающим.
 *
 * Чем это грозит: без `application_token` мы не сможем проверить подлинность входящих
 * СОБЫТИЙ портала. Сегодня это не стоит ничего — подписок нет ни одной (`event.bind`
 * в проекте не вызывается нигде). Если следом придёт `ONAPPINSTALL`, поле заполнится само:
 * запись портала обновляется по `member_id`. Обратный порядок — переустановка через мастер
 * поверх уже полученного событием токена — раньше затирал его пустым молча; теперь
 * `registerPortal` этого не делает, см. там же. Но прежде чем подписываться на первое
 * событие, вопрос обязан быть закрыт по существу: придёт ли `ONAPPINSTALL` тиражному
 * приложению с пунктом в меню — документацией не покрыто и проверяется только живой
 * установкой.
 *
 * Всё остальное проверяется ровно так же, и подлинность доказывается тем же способом —
 * переавторизацией. Поддельный `refresh_token` не переживёт обмена, чей бы он ни был.
 */
export function readFrameGrant(auth: unknown): GrantResult {
  const parsed = readPortalGrant(auth, true)
  if (!parsed.ok) return parsed

  // ⚠ Поле ОБНУЛЯЕТСЯ, а не просто не требуется. Тело запроса пишет клиент, и контракт
  // «мастер не приносит токен приложения» не должен держаться на том, что страница
  // не пришлёт лишнего. Нашла панель ревью PR #27.
  return { ok: true, grant: { ...parsed.grant, applicationToken: '' } }
}
