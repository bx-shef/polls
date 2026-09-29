import type { SmartProcessRef } from '../../domain/portals/smart-processes'
import { isCardOf } from '../../domain/portals/userfield-type'

/**
 * What a field of ours says about the card it is open in, as its page relays it.
 *
 * Общий разбор для обоих полей своего типа — «Результата опроса» и «Анкеты»: у них одни и те же
 * признаки карточки и одни и те же отказы, и две копии разошлись бы на первой же правке.
 */

/** Strictly positive integer, or `null`: empty is not zero. */
export function positiveInteger(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string' && raw.trim() === '') return null
  const value = Number(typeof raw === 'string' ? raw.trim() : raw)
  return Number.isInteger(value) && value > 0 ? value : null
}

/** The card a field is open in: `CRM_<id>` and the entity type, whichever the portal sent. */
export interface CardOwner {
  entityId: string
  entityTypeId: number | null
}

/** Reads the card's signs from the request body. */
export function readCardOwner(body: { entityId?: unknown, entityTypeId?: unknown } | null): CardOwner {
  return {
    entityId: typeof body?.entityId === 'string' ? body.entityId.trim() : '',
    entityTypeId: positiveInteger(body?.entityTypeId),
  }
}

/**
 * Why the field may not show here, or `null` when the card is `ref`'s own.
 *
 * ⚠ «Не прислал признаков» и «прислал чужие» — разные отказы. Первое — сбой встраивания
 * на настоящей карточке, и совет «удалите поле» там был бы вредным. Нашёл `/code-review` в PR #80.
 * Почему это защита от ошибки администратора, а не граница прав, — у `isCardOf`.
 */
export function refuseForeignCard(owner: CardOwner, ref: SmartProcessRef): 'no-owner' | 'foreign-card' | null {
  if (owner.entityId === '' && owner.entityTypeId === null) return 'no-owner'
  return isCardOf(owner, ref) ? null : 'foreign-card'
}
