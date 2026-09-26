import { defineEventHandler, createError, readBody } from 'h3'
import { verifyItemAccess } from '../../b24/frame-auth'
import { readStoredRefs } from '../../b24/provision'
import { readUpdatedItemId } from '../../domain/answers/portal-calls'
import { validateTemplate } from '../../domain/surveys/validate'
import { assignMissingKeys, readIncomingSchema } from '../../domain/templates/schema-input'
import {
  TEMPLATE_STATE_PUBLISHED,
  buildGetTemplateItemCall,
  buildSaveSchemaCall,
  readTemplateItem,
} from '../../domain/templates/portal-calls'
import { logger } from '../../utils/logger'
import { openPortalSession } from './-session'

/**
 * Saves the survey schema back into a draft template.
 *
 * ⚠ ОПУБЛИКОВАННУЮ ВЕРСИЮ НЕ ПИШЕМ НИКОГДА, и проверяется это ЗДЕСЬ, а не только кнопкой
 * во вкладке. Инвариант проекта: опубликованная версия неизменяема, правка порождает новую.
 * Цена нарушения названа в самом инварианте — правка формулировки задним числом рвёт всю
 * накопленную статистику: ответы, собранные по старому тексту, окажутся под новым, и понять,
 * что сравниваются разные вопросы, будет нельзя уже никогда.
 *
 * ⚠ Состояние перечитывается С ПОРТАЛА перед записью, а не берётся из того, что прислал
 * браузер. Вкладка могла быть открыта час назад и не знать, что версию за это время
 * опубликовали, — а верить присланному состоянию значит отдать соблюдение инварианта тому,
 * кого мы и проверяем.
 *
 * ⚠ Схема СОБИРАЕТСЯ ЗАНОВО (`readIncomingSchema`), а не принимается как есть: она попадёт
 * на публичную страницу, которую открывает посторонний человек. Разбор смысла
 * (`validateTemplate`) при этом НЕ запрещает сохранение — черновик с дырой в диапазонах
 * сохранить нужно, иначе его негде доделывать. Запрещает он публикацию.
 */
export default defineEventHandler(async (event) => {
  const session = await openPortalSession(event)
  const body = await readBody<{ itemId?: unknown, schema?: unknown, updatedAt?: unknown }>(event)
    .catch(() => null)

  const itemId = Number(body?.itemId)
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return { ok: false as const, reason: 'no-item' as const }
  }

  const incoming = readIncomingSchema(body?.schema)
  if ('refusal' in incoming) {
    logger.warn({ domain: session.portal.domain, refusal: incoming.refusal }, 'конструктор: схема не принята')
    return { ok: false as const, reason: incoming.refusal }
  }

  const refs = await readStoredRefs(session.call)
  if (refs.template === undefined) {
    return { ok: false as const, reason: 'not-provisioned' as const }
  }

  // ⚠ ДОСТУП ПРОВЕРЯЕТСЯ ТОКЕНОМ СОТРУДНИКА, и для записи это обязательно. Пишем мы токеном
  // приложения — у него права администратора, — поэтому «а можно ли этому человеку» решает
  // портал по своим правам, а не мы по своим догадкам. Без проверки любой сотрудник
  // с фреймовым пропуском мог бы прислать чужой `itemId` и переписать анкету, к которой
  // портал его не подпускает. У роута ЧТЕНИЯ довод другой (там только наши же шаблоны),
  // и копировать его сюда было ошибкой. Нашёл `/code-review`.
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
  if (current.state === TEMPLATE_STATE_PUBLISHED) {
    return { ok: false as const, reason: 'published' as const }
  }

  // ⚠ Отметка изменения сверяется с той, что вкладка получила при открытии. Две вкладки,
  // открытые на одной анкете, иначе молча затирают работу друг друга — и обеим показано
  // «Сохранено». Пустая отметка (портал её не отдал) проверку пропускает: отказывать
  // из-за отсутствующего поля значило бы сломать сохранение целиком. Нашёл `/code-review`.
  const seen = typeof body?.updatedAt === 'string' ? body.updatedAt : ''
  if (seen !== '' && current.updatedAt !== '' && seen !== current.updatedAt) {
    return { ok: false as const, reason: 'stale' as const }
  }

  // ⚠ Код анкеты берётся у СОХРАНЁННОГО элемента, а не у присланной схемы, когда он там уже
  // есть. По коду живут выпущенные ссылки и вся статистика версий: сменив его правкой
  // черновика, автор оторвал бы новую версию от своей же истории — молча и необратимо.
  // ⚠ Ключи раздаются ПОСЛЕ разбора и ТОЛЬКО тем, у кого их нет: добавленный во вкладке
  // вопрос приходит без ключа, потому что выдать его браузер не может — генератор живёт
  // в домене, а `app/` в серверные модули не ходит. Существующие ключи не переписываются
  // никогда: на них держатся уже собранные ответы.
  const keyed = assignMissingKeys(incoming)
  const schema = current.code === '' ? keyed : { ...keyed, code: current.code }

  const save = buildSaveSchemaCall(refs.template, itemId, schema)
  // ⚠ Ответ ЧИТАЕТСЯ. `crm.item.update` отвечает успехом и тогда, когда ничего не изменил,
  // и «Сохранено» на несохранённой анкете — худший из возможных ответов: человек уходит,
  // считая работу сделанной. Тот же приём и тот же читатель, что у записи ответа в портал.
  if (readUpdatedItemId(await session.call(save.method, save.params)) === null) {
    logger.error({ domain: session.portal.domain }, 'портал не подтвердил запись схемы анкеты')
    return { ok: false as const, reason: 'not-saved' as const }
  }

  logger.info(
    { domain: session.portal.domain, sections: schema.sections.length },
    'схема анкеты сохранена',
  )

  // Претензии считаются ПОСЛЕ записи и по тому, что записано: вкладка показывает состояние
  // сохранённого черновика, а не того, что человек только что набрал.
  // Перечитываем элемент: нужна свежая отметка изменения, иначе следующее сохранение
  // из этой же вкладки упрётся в собственную же проверку на одновременную правку.
  const after = readTemplateItem(await session.call(get.method, get.params), refs.template)

  return {
    ok: true as const,
    template: after ?? { ...current, schema },
    problems: validateTemplate(schema),
  }
})
