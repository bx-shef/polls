import { mintToken, hashToken } from '../links/token'

/**
 * Issuing an invitation: everything that can be decided without the portal and without the database.
 *
 * Три входа ведут сюда: кнопка в карточке сделки, робот бизнес-процесса и событие смены стадии
 * (`docs/PROCESS.md`, раздел 6). Поэтому решение живёт отдельной чистой функцией, а не внутри
 * обработчика вкладки: второй и третий вход не должны переписывать его заново, иначе ссылка,
 * выпущенная роботом, окажется устроена чуть иначе, чем выпущенная руками.
 */

/** Срок жизни ссылки по умолчанию, в днях. */
export const DEFAULT_TTL_DAYS = 30

/**
 * Дедупликации здесь НЕТ, и это осознанно.
 *
 * `docs/PROCESS.md`, раздел 6, описывает окно дедупа для двух других входов — робота на стадии
 * и события смены стадии: они срабатывают на одно действие и без окна дадут клиенту два письма.
 * У кнопки в карточке такой беды нет: человек, нажавший «выпустить» второй раз, именно этого
 * и хочет — перевыпустить ссылку. Ключ и колонка под него появятся вместе с роботом,
 * а не раньше: писать их сейчас значило бы завести поле, которое никто не читает.
 */

/** К чему привязано приглашение. Сделка, контакт, компания или элемент смарт-процесса. */
export interface InvitationTarget {
  entityType: string
  entityId: number
}

export interface InvitationRequest {
  memberId: string
  target: InvitationTarget
  surveyCode: string
  surveyVersion: number
  ttlDays?: number
}

export interface Invitation {
  /** Сам токен. Возвращается ровно один раз — дальше живёт только его хеш. */
  token: string
  tokenHash: string
  expiresAt: Date
}

/**
 * Собрать приглашение.
 *
 * ⚠ Токен возвращается наружу ЕДИНСТВЕННЫЙ раз, здесь. Дальше по коду ходит только `tokenHash`:
 * в базу кладётся он, в журнал не попадает ни тот, ни другой. Вызывающий обязан отдать токен
 * пользователю сразу и не сохранять.
 */
export function createInvitation(request: InvitationRequest, now: Date): Invitation {
  const token = mintToken()
  const ttlDays = request.ttlDays ?? DEFAULT_TTL_DAYS

  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000),
  }
}

/**
 * Публичный адрес анкеты.
 *
 * ⚠ Хост берётся у портала, а не из константы: клиент, договорившийся о своём домене, получает
 * ссылки на нём, и это решается одной строкой в базе. Пусто — общий адрес издателя.
 *
 * Адрес обязан быть `https`: ссылка уезжает постороннему человеку в письме, и `http` там
 * означает токен доступа к чужой анкете, летящий открытым текстом.
 */
export function buildSurveyUrl(baseUrl: string, token: string): string | null {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (!/^https:\/\/[^\s/]+$/i.test(trimmed)) return null
  return `${trimmed}/s/${token}`
}
