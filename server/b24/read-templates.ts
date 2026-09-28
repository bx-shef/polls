import { buildListTemplatesCall, readPublishedTemplates, type PublishedTemplate } from '../domain/invitations/portal-calls'
import { readNextOffset, type SmartProcessRef } from '../domain/portals/smart-processes'
import { isStaged } from '../domain/portals/stages'
import { logger } from '../utils/logger'
import type { RestCall } from './provision'

/** Whether a template listing has elements without a stage — stages are off on the portal. */
function hasItemsWithoutStage(response: unknown): boolean {
  const items = (response as { result?: { items?: unknown } } | null)?.result?.items
  return Array.isArray(items) && items.some(item => item !== null && typeof item === 'object' && !('stageId' in item))
}

/**
 * Reads every published template from the portal, across all pages.
 *
 * ⚠ ЗАВЕДЕНО РАДИ ПЕРЕЛИСТЫВАНИЯ, и это исправление настоящего дефекта. Оба вызывающих —
 * вкладка сделки и выпуск ссылки — звали `buildListTemplatesCall` ровно один раз и `next`
 * не читали, хотя параметр `start` у вызова был с первого дня. `crm.item.list` отдаёт
 * пятьдесят элементов на страницу, а отбор по состоянию у нас происходит УЖЕ ПОСЛЕ ответа,
 * то есть черновики и прошлые версии занимают ту же полусотню. Версии неизменяемы и никуда
 * не деваются, поэтому список только растёт: пятьдесят первый опубликованный шаблон просто
 * исчезал бы из выпадающего списка, а выпуск по нему отвечал бы «снят с публикации» — про
 * анкету, которая опубликована. Нашёл `/code-review` в PR #50.
 */

/**
 * Предел перелистывания.
 *
 * Страховка от бесконечного цикла на кривом `next`, а не ожидаемый размер. Здесь, в отличие
 * от операторских скриптов, упёршись в предел мы НЕ падаем: вкладка с неполным списком лучше,
 * чем вкладка с ошибкой, — менеджер увидит анкеты и выпустит ссылку. Цена ошибки другая:
 * там мы необратимо писали в портал, тут только показываем выбор.
 */
const MAX_PAGES = 20

/**
 * Portals whose stages-off warning this process has already written, as `domain/typeId`.
 *
 * ⚠ Раз за жизнь процесса, а не на каждое чтение: список читает каждое открытие вкладки сделки,
 * и одно и то же предупреждение на каждом открытии заглушило бы журнал. Новый выкат скажет снова.
 * Нашёл `/code-review` в панели PR #93.
 */
const warnedStageless = new Set<string>()

/**
 * Reads every published template of the portal: issuable now, or ever published (`readPublishedTemplates`).
 *
 * `domain` — только для журнала: номер смарт-процесса у каждого портала свой и сам по себе
 * портала не называет.
 */
export async function readAllPublishedTemplates(
  call: RestCall,
  template: SmartProcessRef,
  which: 'issuable' | 'ever',
  domain: string,
): Promise<PublishedTemplate[]> {
  const found: PublishedTemplate[] = []
  let start: number | null = 0

  let stageless = false
  for (let page = 0; page < MAX_PAGES && start !== null; page++) {
    const list = buildListTemplatesCall(template, start)
    const response = await call(list.method, list.params)
    found.push(...readPublishedTemplates(response, template, which))
    stageless ||= isStaged(template) && hasItemsWithoutStage(response)
    start = readNextOffset(response)
  }

  // ⚠ Администратор выключил стадии у «Шаблона» — портал прячет `stageId`, и выпуск решает одна
  // дата (`isIssuable`): версия, снятая с публикации стадией, снова предлагается к выпуску. Это
  // размен в пользу «выпуск работает» против «выпуск молча встал целиком», и он должен быть виден.
  // Нашёл `/review` в третьем круге панели PR #93.
  const key = `${domain}/${template.id}`
  if (stageless && !warnedStageless.has(key)) {
    warnedStageless.add(key)
    logger.warn({ domain, typeId: template.id }, 'у «Шаблона опроса» выключены стадии — выпуск решает одна дата публикации')
  }

  return found
}
