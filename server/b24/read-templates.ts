import { buildListTemplatesCall, readPublishedTemplates, type PublishedTemplate } from '../domain/invitations/portal-calls'
import { readNextOffset, type SmartProcessRef } from '../domain/portals/smart-processes'
import type { RestCall } from './provision'

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

/** Все опубликованные шаблоны портала. */
export async function readAllPublishedTemplates(
  call: RestCall,
  template: SmartProcessRef,
): Promise<PublishedTemplate[]> {
  const found: PublishedTemplate[] = []
  let start: number | null = 0

  for (let page = 0; page < MAX_PAGES && start !== null; page++) {
    const list = buildListTemplatesCall(template, start)
    const response = await call(list.method, list.params)
    found.push(...readPublishedTemplates(response, template))
    start = readNextOffset(response)
  }

  return found
}
