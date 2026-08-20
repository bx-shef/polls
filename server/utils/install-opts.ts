// Опции сохранения токенов при установке — отдельной чистой функцией, чтобы их можно было
// ИСПОЛНИТЬ в тесте. Внутри `defineEventHandler` они не проверяются ничем: пропади из роута
// `adoptLocal`, весь фикс #171 выключится, а `pnpm check` останется зелёным — при том что зелёный
// `check` служит гейтом мержа.
import type { SaveTokensOpts } from '~core/bitrix24/portal'

/**
 * Собрать опции `PortalTokenStore.save` для пути установки.
 *
 * `adoptLocal` — ВСЕГДА: плейсхолдер-портал должен становиться этим порталом переименованием строки,
 * иначе удаление приложения чистит пустую строку, а накопленные ПДн остаются в базе (#171).
 *
 * `expectedMemberId` — опциональный гейт (env `B24_EXPECTED_MEMBER_ID`): если инстанс знает, какой
 * портал он обслуживает, чужая установка накопленное не присвоит. Пустая строка и пробелы считаются
 * «не задано» — иначе забытая в `.env` пустая переменная тихо запретила бы присвоение вообще.
 */
export function installSaveOpts(eventTs: number | undefined, expectedRaw: string | undefined): SaveTokensOpts {
  const expected = expectedRaw?.trim()
  return {
    // `eventTs` необязателен: формат install-СТРАНИЦЫ его не несёт. Тумбстоун-гард тогда не
    // включается — так было и раньше, здесь мы это лишь не ломаем.
    ...(eventTs !== undefined ? { eventTs } : {}),
    adoptLocal: true,
    ...(expected ? { expectedMemberId: expected } : {})
  }
}
