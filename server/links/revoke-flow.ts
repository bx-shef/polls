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
 * клиента, и её отказ поднимается наверх: её дописывают повторное нажатие и открытие вкладки
 * (`needsRevokeRepair`). Дело — оформление ленты: его отказ пишется в журнал и только.
 *
 * ⚠ ДЕЛО ЗАКРЫВАЕТСЯ И ТОГДА, КОГДА СТАДИЯ НЕ ЛЕГЛА (`finally`). Дело к элементу не привязано
 * и от стадии не зависит, а стадию портал может отвергать и при каждом дописывании — например,
 * у «Отозвана» обязательное поле. Закрывай мы дело только после стадии, в таком случае открытым
 * с мёртвым адресом оно осталось бы навсегда: кнопки «Отозвать» у ссылки больше нет
 * (`/code-review`, PR #102). Отказ стадии при этом по-прежнему уходит наверх.
 */
export async function reflectRevocation(call: RestCall, survey: SmartProcessRef, itemId: number): Promise<void> {
  const revoke = buildRevokeCall(survey, itemId)
  try {
    await call(revoke.method, revoke.params)
  }
  finally {
    await tryRevokeActivity(call, survey, itemId)
  }
}
