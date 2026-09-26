import { createError, defineEventHandler, readBody } from 'h3'
import { verifyItemAccess } from '../../b24/frame-auth'
import { readStoredRefs } from '../../b24/provision'
import { readUpdatedItemId } from '../../domain/answers/portal-calls'
import { buildListTemplatesCall } from '../../domain/invitations/portal-calls'
import { readNextOffset } from '../../domain/portals/smart-processes'
import { validateTemplate } from '../../domain/surveys/validate'
import {
  TEMPLATE_STATE_PUBLISHED,
  buildGetTemplateItemCall,
  buildNewVersionCall,
  buildPublishTemplateCall,
  findDraftOfCode,
  nextVersion,
  readTemplateItem,
  readVersionsOfCode,
} from '../../domain/templates/portal-calls'
import { logger } from '../../utils/logger'
import { openPortalSession } from './-session'

/**
 * Publishes a draft, or opens a new draft version from a published one.
 *
 * ⚠ ОДИН РОУТ НА ДВА ДЕЙСТВИЯ, и это не экономия. Они взаимно исключают друг друга по самому
 * инварианту: черновик можно опубликовать и нельзя размножить, опубликованную — наоборот.
 * Разведя их по двум роутам, мы получили бы два места, где написана одна и та же проверка
 * состояния, — и однажды они разошлись бы.
 *
 * ⚠ ПУБЛИКАЦИЯ ПРОВЕРЯЕТ СХЕМУ И ОТКАЗЫВАЕТ. Сохранить черновик с дырой в диапазонах можно —
 * иначе его негде доделывать, — а опубликовать нельзя: опубликованная версия неизменяема,
 * и ошибку в ней уже не починить. Это единственное место, где проверка смысла что-то
 * запрещает, и потому она здесь, а не в сохранении.
 */
export default defineEventHandler(async (event) => {
  const session = await openPortalSession(event)
  const body = await readBody<{ itemId?: unknown, action?: unknown }>(event).catch(() => null)

  const itemId = Number(body?.itemId)
  // ⚠ Действие принимается ТОЛЬКО точным совпадением. Прежняя редакция сводила всё, что
  // не `new-version`, к публикации — то есть опечатка или потерянное поле выполняли
  // необратимую операцию. Отказ закрытый: не поняли — не делаем. Нашёл `/code-review`.
  const action = body?.action === 'new-version' || body?.action === 'publish' ? body.action : null
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return { ok: false as const, reason: 'no-item' as const }
  }
  if (action === null) return { ok: false as const, reason: 'no-action' as const }

  const refs = await readStoredRefs(session.call)
  if (refs.template === undefined) {
    return { ok: false as const, reason: 'not-provisioned' as const }
  }

  // Права — токеном сотрудника, по той же причине, что у записи схемы: пишем мы токеном
  // приложения, у которого прав больше, значит решать должен портал.
  const access = await verifyItemAccess(
    session.portal.domain,
    session.authId,
    refs.template.entityTypeId,
    itemId,
  )
  if (!access.ok) {
    if (access.reason === 'unreachable') {
      throw createError({ statusCode: 503, statusMessage: 'Portal unreachable' })
    }
    return { ok: false as const, reason: 'denied' as const }
  }

  const get = buildGetTemplateItemCall(refs.template, itemId)
  const current = readTemplateItem(await session.call(get.method, get.params), refs.template)
  if (current === null) return { ok: false as const, reason: 'no-item' as const }
  if (current.schema === null) return { ok: false as const, reason: 'no-schema' as const }

  const published = current.state === TEMPLATE_STATE_PUBLISHED

  if (action === 'new-version') {
    if (!published) return { ok: false as const, reason: 'not-published' as const }

    // ⚠ ПЕРЕД СОЗДАНИЕМ — ПОИСК СУЩЕСТВУЮЩЕГО, инвариант проекта. Без него каждое нажатие
    // (или повтор запроса после обрыва) заводило бы ещё один черновик той же анкеты, и каждый
    // публиковался бы отдельной версией. Нашёл `/code-review`.
    const existing = await findExistingDraft(session.call, refs.template, current.schema.code)
    if (existing !== null) {
      return { ok: true as const, action: 'new-version' as const, itemId: existing, entityTypeId: refs.template.entityTypeId, reused: true }
    }

    // ⚠ Схема копируется целиком, ключи вопросов — как есть. В этом весь смысл: ответ
    // по вопросу `q17` первой версии и ответ на него же во второй — один и тот же вопрос,
    // и сравнивать их можно только пока ключ тот же.
    const add = buildNewVersionCall(refs.template, current.schema, session.userId)
    const created = await session.call(add.method, add.params) as { result?: { item?: { id?: unknown } } }
    const newId = Number(created?.result?.item?.id)
    if (!Number.isInteger(newId) || newId <= 0) {
      logger.error({ domain: session.portal.domain }, 'портал не подтвердил создание новой версии')
      return { ok: false as const, reason: 'not-saved' as const }
    }

    logger.info({ domain: session.portal.domain, from: itemId, to: newId }, 'заведена новая версия анкеты')
    // ⚠ `entityTypeId` уходит наружу: без него вкладка не соберёт адрес карточки. Сама она
    // его не знает — портал кладёт во фрейм только идентификатор элемента, а тип объекта
    // отдельным ключом не приходит вовсе (документация точки встраивания).
    return { ok: true as const, action: 'new-version' as const, itemId: newId, entityTypeId: refs.template.entityTypeId }
  }

  if (published) return { ok: false as const, reason: 'published' as const }

  const problems = validateTemplate(current.schema)
  const blocking = problems.filter(problem => problem.level === 'error')
  if (blocking.length > 0) {
    return { ok: false as const, reason: 'invalid' as const, problems }
  }

  // ⚠ Номер считается по ВСЕМ версиям этого кода на портале, а не по открытой. Версия —
  // внешний ключ: по паре «код + версия» живут кэш схемы, ссылки и статистика. Выдав
  // занятый номер, мы склеили бы две разные анкеты в одну.
  const version = nextVersion(await readAllVersions(session.call, refs.template, current.schema.code))

  const publish = buildPublishTemplateCall(refs.template, itemId, current.schema, version, new Date())
  if (readUpdatedItemId(await session.call(publish.method, publish.params)) === null) {
    logger.error({ domain: session.portal.domain }, 'портал не подтвердил публикацию анкеты')
    return { ok: false as const, reason: 'not-saved' as const }
  }

  logger.info({ domain: session.portal.domain, code: current.schema.code, version }, 'анкета опубликована')
  return { ok: true as const, action: 'publish' as const, version }
})

/**
 * Предел перелистывания. Страховка от кривого `next`, а не ожидаемый размер.
 *
 * ⚠ Заведён потому, что ОДНОЙ страницы мало, и это не теория. `crm.item.list` отдаёт пятьдесят
 * элементов, версии неизменяемы и только копятся, а отбор по коду идёт УЖЕ ПОСЛЕ ответа —
 * значит на пятьдесят первом шаблоне версии нужного кода уезжают со страницы, и `nextVersion`
 * выдаёт номер, который уже был. Ровно тот дефект, ради которого в PR #50 появился
 * `read-templates.ts`. Нашёл `/code-review`.
 */
const MAX_PAGES = 20

/** Все номера версий этого кода, со всех страниц. */
async function readAllVersions(
  call: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  template: { entityTypeId: number, id: number },
  code: string,
): Promise<number[]> {
  const found: number[] = []
  let start: number | null = 0

  for (let page = 0; page < MAX_PAGES && start !== null; page++) {
    const listing = buildListTemplatesCall(template, start)
    const response = await call(listing.method, listing.params)
    found.push(...readVersionsOfCode(response, template, code))
    start = readNextOffset(response)
  }

  return found
}

/** Черновик этого кода, если он уже есть. Ищем так же постранично: он может быть где угодно. */
async function findExistingDraft(
  call: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  template: { entityTypeId: number, id: number },
  code: string,
): Promise<number | null> {
  let start: number | null = 0

  for (let page = 0; page < MAX_PAGES && start !== null; page++) {
    const listing = buildListTemplatesCall(template, start)
    const response = await call(listing.method, listing.params)
    const draft = findDraftOfCode(response, template, code)
    if (draft !== null) return draft
    start = readNextOffset(response)
  }

  return null
}
