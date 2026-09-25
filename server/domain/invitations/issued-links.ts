import { buildFieldName, type PortalCall, type SmartProcessRef } from '../portals/smart-processes'
import { SURVEY_STATE_COMPLETED } from '../answers/portal-calls'
import { SURVEY_STATE_SENT } from './portal-calls'

/**
 * The links already issued for a deal — read from the portal, not from our database.
 *
 * ⚠ ИСТОЧНИК СПИСКА — ПОРТАЛ, и это прямое следствие инварианта «не хранить у себя то, что
 * можно положить в портал». Каждая выпущенная ссылка и ЕСТЬ элемент смарт-процесса «Опрос»:
 * там лежат код и версия анкеты, срок действия, состояние, дата прохождения, балл и — в поле
 * «ответственный» — тот, кто нажал «выпустить». Issue #20 просил завести у нас колонку
 * «кто выпустил»; заводить её не потребовалось, ответ уже был на портале.
 *
 * У нас в `link_index` лежит только то, чего в портале быть не может: хеш токена, снимок шапки
 * для публичной страницы и состояние доставки. Показывать список оттуда значило бы завести
 * второй источник истины ради удобства чтения.
 *
 * ⚠ Состояние ссылки СЧИТАЕТСЯ, а не хранится готовым. На портале лежит `STATE` (`sent`,
 * `completed`, `revoked`), а «просрочена» — это не состояние, а сравнение срока с сегодняшним
 * днём. Записывать просрочку полем значило бы завести задание, которое ходит по чужим порталам
 * и переписывает элементы ради того, что вычисляется одной строкой.
 */

/** Ссылка отозвана вручную: показывать её больше нельзя, отвечать по ней — тоже. */
export const SURVEY_STATE_REVOKED = 'revoked'

/** Одна выпущенная ссылка — ровно то, что о ней знает портал. */
export interface IssuedLink {
  itemId: number
  title: string
  code: string
  version: number
  /** `STATE` элемента как есть: `sent`, `completed`, `revoked` или пусто у старых элементов. */
  state: string
  /** Дата в форме, в какой её отдал портал; пусто — поле не заполнено. */
  expiresAt: string
  completedAt: string
  score: number | null
  /** Кто выпустил: ответственный за элемент. Ноль — портал не прислал. */
  assignedById: number
  createdAt: string
}

/** Что показывать человеку. Считается по состоянию и сроку, полем нигде не лежит. */
export type IssuedState = 'active' | 'completed' | 'revoked' | 'expired'

/**
 * Список ссылок сделки.
 *
 * ⚠ Фильтр по родителю проверен на живом портале 24.09: `{ parentId2: <сделка> }` отбирает
 * (26 элементов всего, 24 у сделки 2, 0 у несуществующей). Форма `PARENT_ID_2` работает так же,
 * взята camelCase — в ней же `crm.item.get` отдаёт связь, и разнобой тут ничего не даёт.
 *
 * ⚠ `select: ['*']` обязателен вместе с `useOriginalUfNames`. Иначе портал молча теряет
 * системные поля — разбор этого уже есть в `docs/PROCESS.md`, и `id` с `assignedById`
 * относятся ровно к ним.
 *
 * ⚠ Берём ОДНУ страницу, новые сверху, и это осознанно. `crm.item.list` отдаёт полсотни
 * за раз; у сделки с полусотней выпущенных ссылок список всё равно нечитаем, а перелистывание
 * ради него — лишние обращения к порталу на каждое открытие вкладки. Цена ошибки здесь
 * не та, что у списка шаблонов: там непрочитанная страница делала выпуск невозможным,
 * здесь — не показывает самые старые ссылки, которые давно истекли.
 */
export function buildListIssuedCall(survey: SmartProcessRef, dealId: number): PortalCall {
  return {
    method: 'crm.item.list',
    params: {
      entityTypeId: survey.entityTypeId,
      useOriginalUfNames: 'Y',
      select: ['*'],
      filter: { parentId2: dealId },
      order: { id: 'desc' },
    },
  }
}

/**
 * Разобрать ответ портала в список ссылок.
 *
 * ⚠ Имена полей строятся по `survey.id`, а НЕ по `entityTypeId`. Проверено на живом портале:
 * поля называются `UF_CRM_10_STATE` при `entityTypeId` 1040. Перепутав, мы прочитали бы
 * `undefined` во всех полях и показали список из пустых строк — молча и правдоподобно.
 */
export function readIssuedLinks(response: unknown, survey: SmartProcessRef): IssuedLink[] {
  const items = (response as { result?: { items?: unknown } } | null)?.result?.items
  if (!Array.isArray(items)) return []

  const field = (postfix: string) => buildFieldName(survey.id, postfix)

  return items.flatMap((raw) => {
    if (raw === null || typeof raw !== 'object') return []
    const item = raw as Record<string, unknown>

    const itemId = asPositiveInt(item.id)
    if (itemId === null) return []

    return [{
      itemId,
      title: text(item.title),
      code: text(item[field('TEMPLATE_CODE')]),
      version: asPositiveInt(item[field('TEMPLATE_VERSION')]) ?? 0,
      state: text(item[field('STATE')]),
      expiresAt: text(item[field('EXPIRES_AT')]),
      completedAt: text(item[field('COMPLETED_AT')]),
      score: asScore(item[field('SCORE')]),
      assignedById: asPositiveInt(item.assignedById) ?? 0,
      createdAt: text(item.createdTime),
    }]
  })
}

/**
 * Что показать в списке напротив ссылки.
 *
 * ⚠ Порядок проверок — смысловой, а не произвольный. Отозванная ссылка остаётся отозванной,
 * даже когда её срок вышел: менеджер должен видеть, что её погасили, а не что она «просто
 * истекла». Пройденная — тем более: у неё уже есть ответ клиента, и срок к ней отношения
 * не имеет. Поменяв порядок, мы стёрли бы разницу между «её остановили» и «её не открыли».
 */
export function issuedState(link: IssuedLink, now: Date): IssuedState {
  if (link.state === SURVEY_STATE_REVOKED) return 'revoked'
  if (link.state === SURVEY_STATE_COMPLETED) return 'completed'

  const expires = Date.parse(link.expiresAt)
  if (!Number.isNaN(expires) && expires < now.getTime()) return 'expired'

  return 'active'
}

/** Ссылку ещё можно остановить: она не пройдена, не отозвана и не истекла. */
export function isRevocable(link: IssuedLink, now: Date): boolean {
  return issuedState(link, now) === 'active'
}

/**
 * Погасить ссылку на портале.
 *
 * ⚠ Меняем ТОЛЬКО состояние. Элемент — запись о приглашении, и стирать с него код анкеты,
 * срок или ответственного нельзя: отозванная ссылка обязана остаться читаемой историей
 * («выпустили тогда-то, погасили»), иначе отзыв превращается в тихое удаление.
 *
 * ⚠ Состояние — не единственное, что делает отзыв: страницу закрывает НАША запись
 * (`link_index.status`), потому что публичная страница в портал не ходит по инварианту.
 * Здесь — то, что видит менеджер в карточке.
 */
export function buildRevokeCall(survey: SmartProcessRef, itemId: number): PortalCall {
  return {
    method: 'crm.item.update',
    params: {
      entityTypeId: survey.entityTypeId,
      id: itemId,
      useOriginalUfNames: 'Y',
      fields: { [buildFieldName(survey.id, 'STATE')]: SURVEY_STATE_REVOKED },
    },
  }
}

/** Состояние, с которым ссылка выпускается: нужно, чтобы отличать её от отозванной. */
export { SURVEY_STATE_SENT }

function text(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : ''
}

function asPositiveInt(raw: unknown): number | null {
  const value = Number(typeof raw === 'string' ? raw.trim() : raw)
  return Number.isInteger(value) && value > 0 ? value : null
}

/**
 * Балл или «его нет».
 *
 * ⚠ `null` ОТСЕКАЕТСЯ ПЕРВОЙ СТРОКОЙ, и это не перестраховка. Незаполненное поле `double`
 * портал отдаёт именно как `null` (замерено 24.09 на элементе без ответов), а `Number(null)`
 * в JavaScript равен НУЛЮ. Без этой строки список показывал бы «балл 0» у анкеты, которую
 * никто не проходил, — то есть ровно то, что инвариант проекта запрещает на другом конце
 * пути: «нет ответа — это `null`, а не честный ноль». Поймано живым прогоном; юнит-тест
 * до того проверял пустую СТРОКУ, которой портал не присылает.
 */
function asScore(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null

  const value = typeof raw === 'string' ? raw.trim() : raw
  if (value === '') return null

  const score = Number(value)
  return Number.isFinite(score) ? score : null
}
