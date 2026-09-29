import { defineEventHandler, readBody } from 'h3'
import { readStoredRefs } from '../../b24/provision'
import { readUpdatedItemId } from '../../domain/answers/portal-calls'
import { buildListTemplatesCall } from '../../domain/invitations/portal-calls'
import { readNextOffset } from '../../domain/portals/smart-processes'
import { validateTemplate } from '../../domain/surveys/validate'
import {
  isFrozen,
  isStale,
  buildNewVersionCall,
  buildPublishTemplateCall,
  findDraftOfCode,
  nextVersion,
  readVersionsOfCode,
} from '../../domain/templates/portal-calls'
import { logger } from '../../utils/logger'
import { openPortalSession } from './-session'
import { openTemplate } from './-template-access'

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
  const body = await readBody<{ itemId?: unknown, action?: unknown, updatedAt?: unknown }>(event).catch(() => null)

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
  // приложения, у которого прав больше, значит решать должен портал. Вход общий с чтением
  // и сохранением (`openTemplate`), и отказ `hidden-fields` здесь несущий: иначе публикация
  // выпустила бы схему, которой сотрудник не видел, а отказ проверки ниже отдал бы её
  // формулировки. Нашли `/review` и `/code-review` в PR #104.
  const opened = await openTemplate(session, refs.template, itemId)
  if (!opened.ok) return { ok: false as const, reason: opened.reason }
  const { userView, current } = opened
  if (current.schema === null) return { ok: false as const, reason: 'no-schema' as const }

  // Опубликованная ИЛИ снятая с публикации: обе неизменяемы, и от обеих заводится новая версия.
  const published = isFrozen(current.state)

  if (action === 'new-version') {
    if (!published) return { ok: false as const, reason: 'not-published' as const }

    // ⚠ ПЕРЕД СОЗДАНИЕМ — ПОИСК СУЩЕСТВУЮЩЕГО, инвариант проекта. Без него каждое нажатие
    // (или повтор запроса после обрыва) заводило бы ещё один черновик той же анкеты, и каждый
    // публиковался бы отдельной версией. Нашёл `/code-review`.
    const existing = await findExistingDraft(session.call, refs.template, current.schema.code)
    if (existing === 'truncated') return listTruncated(session.portal.domain, action)
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

  // ⚠ Публикуется та редакция, которую сотрудник видел во вкладке, а не та, что лежит на портале
  // сейчас. Черновик мог сохранить коллега из соседней вкладки, пока эта была открыта, и выпуск
  // необратим: номер занят, по версии выпускают ссылки. Та же сверка отметки, что у сохранения
  // (`isStale`); нашёл `/review` во втором замыкающем круге PR #104. Новой версии она не нужна:
  // её заводят от опубликованной, а та не меняется.
  const seen = typeof body?.updatedAt === 'string' ? body.updatedAt : ''
  if (isStale(seen, userView.updatedAt)) return { ok: false as const, reason: 'stale' as const }

  const problems = validateTemplate(current.schema)
  const blocking = problems.filter(problem => problem.level === 'error')
  if (blocking.length > 0) {
    return { ok: false as const, reason: 'invalid' as const, problems }
  }

  // ⚠ Номер считается по ВСЕМ версиям этого кода на портале, а не по открытой. Версия —
  // внешний ключ: по паре «код + версия» живут кэш схемы, ссылки и статистика. Выдав
  // занятый номер, мы склеили бы две разные анкеты в одну.
  const versions = await readAllVersions(session.call, refs.template, current.schema.code)
  if (versions === 'truncated') return listTruncated(session.portal.domain, action)
  const version = nextVersion(versions)

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

/**
 * Refuses a release whose template list did not end within the page cap, naming the portal in the log.
 *
 * ⚠ Ответ вкладке, а не исключение. Исключение уходило пятисотым, вкладка звала его обрывом связи —
 * «проверьте и попробуйте ещё раз», хотя повтор не поможет, пока список длиннее предела, — а своей
 * строки с порталом в журнале не было. Нашли `/review` и `/code-review` во втором круге PR #113.
 */
function listTruncated(domain: string, action: 'publish' | 'new-version') {
  logger.warn({ domain, action, pages: MAX_PAGES }, 'список шаблонов не дочитан до конца — выпуск остановлен')
  return { ok: false as const, reason: 'list-truncated' as const }
}

/** Every version number of this code across all pages; `'truncated'` when the list did not end within the cap. */
async function readAllVersions(
  call: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  template: { entityTypeId: number, id: number },
  code: string,
): Promise<number[] | 'truncated'> {
  const found: number[] = []
  let start: number | null = 0

  for (let page = 0; page < MAX_PAGES && start !== null; page++) {
    const listing = buildListTemplatesCall(template, start)
    const response = await call(listing.method, listing.params)
    found.push(...readVersionsOfCode(response, template, code))
    start = readNextOffset(response)
  }

  // ⚠ Не дочитали — отказ, а не номер по неполному списку: выданный так номер мог оказаться занятым,
  // и две анкеты склеились бы в одну пару «код + версия». Тот же приём, что у операторского двойника
  // (`publish-templates.ts`). С #110 листание заработало, и предел стал достижим — `/review`
  // и `/code-review` в PR #113.
  if (start !== null) return 'truncated'
  return found
}

/**
 * This code's draft if there is one, `null` if none; `'truncated'` when the list did not end within the cap.
 *
 * Ищем постранично: черновик может лежать где угодно.
 */
async function findExistingDraft(
  call: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  template: { entityTypeId: number, id: number },
  code: string,
): Promise<number | null | 'truncated'> {
  let start: number | null = 0

  for (let page = 0; page < MAX_PAGES && start !== null; page++) {
    const listing = buildListTemplatesCall(template, start)
    const response = await call(listing.method, listing.params)
    const draft = findDraftOfCode(response, template, code)
    if (draft !== null) return draft
    start = readNextOffset(response)
  }

  // Не дочитали — не «черновика нет»: иначе новая версия завела бы второй черновик той же анкеты.
  if (start !== null) return 'truncated'
  return null
}
