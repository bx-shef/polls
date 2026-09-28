import { safeRefusal } from '../domain/answers/portal-errors'
import { buildSurveyUrl, createInvitation } from '../domain/invitations/invitation'
import {
  buildCreateSurveyItemCall,
  buildDealFactsBatch,
  buildWithdrawSurveyItemCall,
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
 * 3. Хеш токена пишется в наш кэш-индекс ПОСЛЕДНИМ, когда известен идентификатор элемента.
 *
 * Падение на третьем шаге оставило бы в элементе адрес анкеты, ведущий на «не найдено»: с 28.09
 * адрес пишется в элемент вторым шагом. Поэтому элемент тогда отзывается — адрес стирается,
 * состояние становится «отозвано» (`withdrawItem`), и это видно и чинится перевыпуском.
 * Обратный порядок оставил бы ссылку, ведущую в никуда, а её уже не отозвать: она у человека
 * в письме.
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
    link: url,
  })
  // ⚠ В `try`, и отказ наружу уходит только нашей строкой (`safeRefusal`). С 28.09 в вызове
  // лежит адрес анкеты С ТОКЕНОМ, а Битрикс24 цитирует присланное значение в тексте ошибки
  // проверки поля. Необработанное исключение h3 и Nitro печатают целиком, в обход нашего
  // журнала и его вырезания секретов, — токен уехал бы в журнал сырым текстом. Ответы клиента
  // по той же причине защищены в `deliver.ts`. Нашла безопасность в панели ревью PR #87.
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
    await withdrawItem(input, itemId)
    throw error
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
 * Отозвать элемент, чья ссылка не легла в наш индекс: стереть адрес, пометить «отозвано».
 *
 * Отказ портала здесь только пишется в журнал: исходную беду — упавшую запись в индекс —
 * вызывающий бросает дальше сам, и прятать её за второй ошибкой нельзя.
 */
async function withdrawItem(input: IssueInput, itemId: number): Promise<void> {
  const withdraw = buildWithdrawSurveyItemCall(input.survey, itemId)
  try {
    await input.call(withdraw.method, withdraw.params)
  }
  catch (error) {
    logger.error(
      { domain: input.domain, itemId, reason: safeRefusal(error) },
      'выпуск ссылки: элемент с неработающей ссылкой не отозван — сотрите адрес в карточке руками',
    )
  }
}
