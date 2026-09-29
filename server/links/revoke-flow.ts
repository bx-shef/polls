import type { RestCall } from '../b24/provision'
import { tryRevokeActivity } from '../b24/survey-activity'
import { buildRevokeCall } from '../domain/invitations/issued-links'
import type { SmartProcessRef } from '../domain/portals/smart-processes'

/**
 * The portal side of revoking a link: what a manager sees once our row is already off.
 *
 * ⚠ ВЫНЕСЕНО ИЗ ОБРАБОТЧИКА РАДИ ЖИВОЙ ПРОВЕРКИ — тот же довод, что у `issue-flow.ts`:
 * `pnpm verify:link` обязана проходить тот же путь, что кнопка «Отозвать», а не свою копию.
 *
 * ⚠ ЗДЕСЬ НЕТ НИ ПРАВ, НИ НАШЕЙ СТРОКИ. Видит ли сотрудник сделку и чей элемент — решает
 * обработчик фреймовым токеном; гасит ссылку наша строка `link_index` (`revokeLink`) — ДО вызова
 * сюда. Сюда приходят, только когда ссылка уже не открывается.
 *
 * Порядок: стадия «Отозвана», потом дело выпуска. Стадия — отражение, на которое смотрят роботы
 * клиента, и её отказ поднимается наверх: повторное нажатие дописывает её
 * (`needsRevokeRepair`). Дело — оформление ленты: его отказ пишется в журнал и только.
 */
export async function reflectRevocation(call: RestCall, survey: SmartProcessRef, itemId: number): Promise<void> {
  const revoke = buildRevokeCall(survey, itemId)
  await call(revoke.method, revoke.params)
  await tryRevokeActivity(call, itemId)
}
