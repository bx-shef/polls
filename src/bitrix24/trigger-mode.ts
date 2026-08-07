/**
 * Режим авто-триггера: каким путём опрос запускается при доходе сделки до стадии.
 *
 * Путей два, и **включать оба одновременно опасно**: робот вызывается на входе в стадию, а событие
 * `ONCRMDEALUPDATE` приходит тем же изменением — история подтвердит свежий переход, и клиент получит
 * ДВА приглашения на один переход. Поэтому режим — единственный источник правды: он решает и что
 * регистрировать при установке, и какой входящий роут обслуживать.
 *
 * - `event` (дефолт) — только `event.bind ONCRMDEALUPDATE` + подтверждение перехода историей стадий.
 *   Работает на всех тарифах.
 * - `robot` — только робот автоматизации: точная семантика «вошла в стадию», но нужен тариф с роботами.
 * - `both` — оба пути. Осознанный выбор оператора: допустим, только если робот НЕ повешен на
 *   триггер-стадию опроса (иначе дубль приглашения).
 *
 * Сейчас режим читается из окружения; когда появится страница настроек портала, она будет питать
 * тот же резолвер — контракт (`resolveTriggerMode`) не изменится.
 */

export const TRIGGER_MODES = ['event', 'robot', 'both'] as const
export type TriggerMode = (typeof TRIGGER_MODES)[number]

export const TRIGGER_MODE_DEFAULT: TriggerMode = 'event'

/** Разбор значения из настроек/окружения; мусор/пусто → дефолт (`event` — работает на всех тарифах). */
export function resolveTriggerMode(raw: unknown): TriggerMode {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return (TRIGGER_MODES as readonly string[]).includes(v) ? (v as TriggerMode) : TRIGGER_MODE_DEFAULT
}

/** Обслуживать ли входящее событие `ONCRMDEALUPDATE` (и регистрировать `event.bind` при установке). */
export function eventTriggerEnabled(mode: TriggerMode): boolean {
  return mode === 'event' || mode === 'both'
}

/** Обслуживать ли вызов робота (и регистрировать `bizproc.robot.add` при установке). */
export function robotTriggerEnabled(mode: TriggerMode): boolean {
  return mode === 'robot' || mode === 'both'
}
