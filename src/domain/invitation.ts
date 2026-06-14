import type { InvitationPolicy, InviteChannel } from './schema'

/**
 * Чистая доменная логика приглашений (invitation-flow #3). Стор и HTTP-проброс —
 * в `src/api/invitation.ts` и `src/api/handlers.ts`; здесь только детерминированные
 * решения «звать / каким каналом», которые binding-слой применяет к живым данным
 * портала (стадия сделки, доступные каналы контакта).
 */

/** Запускается ли опрос на этой стадии сделки (триггер задаёт сам опрос). */
export function shouldInvite(stageId: string | null | undefined, policy: InvitationPolicy): boolean {
  return stageId != null && policy.triggerStages.includes(stageId)
}

/**
 * Канал приглашения: первый из `channelOrder` опроса, доступный у контакта.
 * `undefined` → канала нет; binding-слой пишет пропуск в таймлайн сделки/смарт-элемента.
 */
export function chooseChannel(
  available: Iterable<InviteChannel>,
  policy: InvitationPolicy
): InviteChannel | undefined {
  const have = new Set(available)
  return policy.channelOrder.find((c) => have.has(c))
}
