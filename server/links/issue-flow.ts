import { safeRefusal } from '../domain/answers/portal-errors'
import { buildSurveyUrl, createInvitation } from '../domain/invitations/invitation'
import {
  buildCreateSurveyItemCall,
  buildDealFactsBatch,
  buildItemLinkCall,
  buildInvitationTitle,
  readCreatedItemId,
  readDealFacts,
  readSurveyHeader,
  type PublishedTemplate,
  type SurveyHeader,
} from '../domain/invitations/portal-calls'
import type { RestBatch, RestCall } from '../b24/provision'
import type { SmartProcessRef } from '../domain/portals/smart-processes'
import { cacheTemplate, insertLink } from './issue'
import { logger } from '../utils/logger'

/**
 * Issuing a survey link: everything that happens after we know WHO is asking and for WHICH deal.
 *
 * ⚠ ВЫНЕСЕНО ИЗ ОБРАБОТЧИКА РАДИ ЖИВОЙ ПРОВЕРКИ, и это не косметика. `pnpm verify:link`
 * обязана проходить ТОТ ЖЕ путь, что вкладка сделки, — иначе она проверяет свою копию кода,
 * а копии расходятся ровно тогда, когда одну из них правят. Issue #43 заводился именно из-за
 * этого: три дефекта из четырёх ловились глазами на карточке, потому что автоматической
 * проверки самого пути не существовало.
 *
 * ⚠ Проверки прав здесь НЕТ и быть не должно. Кто спрашивает и видит ли он эту сделку —
 * решает обработчик своим фреймовым токеном, ДО вызова сюда. Скрипт проверки приходит
 * с вебхуком оператора, у которого прав и так больше; смешать эти два случая в одной функции
 * значило бы однажды получить выпуск без проверки доступа.
 *
 * ⚠ Порядок шагов и есть смысл файла, он не переставляется:
 *
 * 1. Схема кладётся в кэш ДО того, как ссылка попадёт человеку. Публичная страница в портал
 *    не ходит по инварианту, и промах кэша — это пожизненный 503 по выданной ссылке.
 * 2. Элемент смарт-процесса создаётся ВТОРЫМ: приглашение и есть этот элемент, источник
 *    истины — портал.
 * 3. Хеш токена пишется в наш кэш-индекс, когда известен идентификатор элемента.
 * 4. Адрес анкеты уходит в элемент ПОСЛЕДНИМ — когда индекс уже знает токен (`buildItemLinkCall`).
 *
 * Падение на третьем шаге оставляет на портале элемент без ссылки — это видно и чинится
 * перевыпуском. Обратный порядок оставил бы ссылку, ведущую в никуда, а её уже не отозвать:
 * она у человека в письме. По той же причине адрес в CRM появляется только четвёртым шагом:
 * положенный в элемент раньше, он при упавшем индексе или при таймауте создания остался бы
 * в карточке рабочей на вид ссылкой на «не найдено» (второй круг панели PR #87).
 */

/** Что нужно знать, чтобы выпустить ссылку. Всё остальное функция добывает сама. */
export interface IssueInput {
  /** Вызов портала. Токеном приложения из обработчика, вебхуком — из проверки. */
  call: RestCall
  /** Он же пакетом: сделка, её компания и её контакт читаются одним обращением. */
  batch: RestBatch
  /** Наш идентификатор портала: под него пишутся кэш схемы и строка ссылки. */
  portalId: string
  /** Домен — только для журнала. */
  domain: string
  /** Публичный адрес, от которого строится ссылка. */
  baseUrl: string
  /** Смарт-процесс «Опрос»: в нём и создаётся приглашение. */
  survey: SmartProcessRef
  dealId: number
  template: PublishedTemplate
  /** Кто выпустил: на него повесится дело по итогу. Ноль — портал поставит владельца токена. */
  assignedById: number
  /** Его же имя для шапки анкеты. Пусто — строка не покажется. */
  managerName: string
}

export type IssueResult
  = | { ok: true, url: string, expiresAt: Date, itemId: number, header?: SurveyHeader }
    | { ok: false, reason: 'no-public-host' | 'item-not-created' }

/**
 * Выпустить одну ссылку.
 *
 * ⚠ Токен наружу отдаётся только внутри `url`. Отдельного поля с ним здесь нет намеренно:
 * чем меньше мест, где он существует, тем меньше мест, откуда он утечёт. Вызывающему, которому
 * нужен сам токен (проверке), достаточно последнего сегмента адреса.
 *
 * ⚠ С 28.09 адрес живёт и в CRM клиента — в поле «Ссылка на анкету» элемента (решение
 * владельца, issue #84, пункт 20: «это не страшный секрет»). У нас по-прежнему только хеш,
 * инвариант про НАШЕ хранилище держится. Цена: ответить вместо клиента может любой, кто видит
 * элемент, — записано в `docs/PROCESS.md`.
 */
export async function issueLink(input: IssueInput): Promise<IssueResult> {
  const invitation = createInvitation({}, new Date())

  const url = buildSurveyUrl(input.baseUrl, invitation.token)
  if (url === null) {
    // Без `https`-хоста ссылка означала бы токен доступа к чужой анкете, летящий открытым
    // текстом. Лучше не выпустить, чем выпустить такую.
    logger.error({ domain: input.domain }, 'выпуск ссылки: публичный адрес не настроен или не https')
    return { ok: false, reason: 'no-public-host' }
  }

  await cacheTemplate(input.portalId, input.template.code, input.template.version, input.template.schema)

  // ⚠ Сделка, её компания и её контакт читаются ОДНИМ пакетом. Неудача чтения ссылку
  // НЕ роняет: ссылка важнее и шапки, и удобства карточки. Поменять их местами было бы
  // ошибкой — человек остался бы без ссылки из-за того, что у сделки не заполнен контакт.
  let deal
  let header: SurveyHeader | undefined
  try {
    const facts = await input.batch(buildDealFactsBatch(input.dealId))
    deal = readDealFacts(facts)
    header = readSurveyHeader(facts, input.managerName)
  }
  catch {
    logger.warn({ domain: input.domain }, 'сделка не прочитана, приглашение уйдёт без клиента и без её названия')
  }

  const createCall = buildCreateSurveyItemCall(input.survey, input.dealId, {
    templateCode: input.template.code,
    templateVersion: input.template.version,
    expiresAt: invitation.expiresAt,
    title: buildInvitationTitle(input.template.title, deal?.title ?? ''),
    client: deal,
    assignedById: input.assignedById,
  })
  // ⚠ В `try`, и отказ наружу уходит только нашей строкой (`safeRefusal`). Битрикс24 цитирует
  // присланное значение в тексте ошибки проверки поля, а в вызове лежат название сделки и её
  // клиент. Необработанное исключение h3 и Nitro печатают целиком, в обход нашего журнала
  // и его вырезания секретов. Ответы клиента по той же причине защищены в `deliver.ts`.
  // Нашла безопасность в панели ревью PR #87 — тогда в этом вызове лежал и адрес с токеном.
  let created: unknown
  try {
    created = await input.call(createCall.method, createCall.params)
  }
  catch (error) {
    logger.error({ domain: input.domain, reason: safeRefusal(error) }, 'выпуск ссылки: портал не создал элемент')
    return { ok: false, reason: 'item-not-created' }
  }
  const itemId = readCreatedItemId(created)
  if (itemId === null) {
    logger.error({ domain: input.domain }, 'выпуск ссылки: портал не вернул идентификатор элемента')
    return { ok: false, reason: 'item-not-created' }
  }

  try {
    await insertLink({
      portalId: input.portalId,
      tokenHash: invitation.tokenHash,
      itemId,
      surveyCode: input.template.code,
      surveyVersion: input.template.version,
      expiresAt: invitation.expiresAt,
      // ⚠ Шапка кладётся СНИМКОМ и только здесь. Публичная страница в портал не ходит,
      // значит другого способа показать респонденту компанию и проект у неё нет.
      header,
    })
  }
  catch (error) {
    // ⚠ Бросаем СВОЮ ошибку, без исходной. Драйвер базы кладёт в текст «Failed query … params: …»,
    // а в параметрах этой вставки — хеш токена и снимок шапки с именами компании, контакта
    // и менеджера. Обработчик выпуска исключение не ловит, и h3 напечатал бы его целиком.
    // Адреса в элементе при этом нет: он уходит туда только следующим шагом. Нашёл `/code-review`
    // во втором круге PR #87.
    logger.error({ domain: input.domain, itemId, sqlState: sqlState(error) }, 'выпуск ссылки: индекс ссылок не записан, элемент остался без ссылки')
    // Исходную ошибку в `cause` не кладём намеренно: h3 печатает и её — ради этого и своя ошибка.
    // eslint-disable-next-line preserve-caught-error
    throw new Error('выпуск ссылки: индекс ссылок не записан')
  }

  // ⚠ Отказ здесь выпуск НЕ отменяет: ссылка уже работает, и выпустивший видит её во вкладке
  // сделки. Не будет только адреса в карточке элемента — это видно, и в журнал уходит код.
  const linkCall = buildItemLinkCall(input.survey, itemId, url)
  try {
    await input.call(linkCall.method, linkCall.params)
  }
  catch (error) {
    logger.warn({ domain: input.domain, itemId, reason: safeRefusal(error) }, 'выпуск ссылки: адрес не записан в элемент — ссылка работает')
  }

  // ⚠ В журнал уходит что угодно, кроме токена и его хеша. Ссылка живёт тридцать дней,
  // а журналы переживают инцидент и утекают вместе с ним.
  logger.info(
    {
      domain: input.domain,
      code: input.template.code,
      version: input.template.version,
      itemId,
      userId: input.assignedById,
    },
    'ссылка выпущена',
  )

  return { ok: true, url, expiresAt: invitation.expiresAt, itemId, header }
}

/**
 * SQLSTATE of a database failure, if there is one: five characters and nothing of the query.
 *
 * Код ошибки Postgres безопасен для журнала и отличает «нет связи» от нарушенного ограничения;
 * текст ошибки — нет (разбор — у вызывающего).
 */
function sqlState(error: unknown): string | undefined {
  const bag = error as { code?: unknown, cause?: { code?: unknown } } | null
  const code = bag?.cause?.code ?? bag?.code
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined
}
