/**
 * Reads the authorization data the portal frame hands us.
 *
 * ⚠ Существует потому, что типы SDK здесь НЕ ЗАЩИЩАЮТ. У `AuthData` объявлена индексная
 * сигнатура `[key: string]: any`, и любая опечатка в имени поля компилируется молча,
 * превращаясь в `undefined` во время работы. Так и случилось: код читал `auth.memberId`,
 * тогда как SDK отдаёт `member_id` (`dist/esm/frame/auth.mjs`, `getAuthData`). Вкладка
 * в карточке сделки отправляла на сервер `memberId: undefined` и не заработала бы ни разу —
 * при зелёном `pnpm check` и зелёном typecheck.
 *
 * Поэтому имена полей живут здесь, в одной чистой функции с тестами, а не по месту
 * в трёх компонентах. Тот же приём и по той же причине, что в `app/utils/placement.ts`.
 */

/** Пропуск, который сервер проверит у портала. Сами по себе эти значения ничего не дают. */
export interface FramePass {
  memberId: string
  /** Фреймовый токен сотрудника. Живёт час, принадлежит человеку, а не приложению. */
  authId: string
  /** Грант администратора. Есть только при установке; в обычной работе не нужен. */
  refreshToken: string
  /** Домен портала — голым хостом, без схемы. См. `portalHost`. */
  domain: string
}

/**
 * Разобрать `getAuthData()`.
 *
 * `null` — фрейм не дал данных: токен протух либо страница открыта не из портала.
 * Различать эти случаи здесь нечем, да и незачем: оба означают «работать нельзя».
 */
export function readFramePass(raw: unknown): FramePass | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null

  const auth = raw as Record<string, unknown>
  const memberId = text(auth.member_id)
  const authId = text(auth.access_token)
  if (memberId === '' || authId === '') return null

  return {
    memberId,
    authId,
    refreshToken: text(auth.refresh_token),
    domain: portalHost(text(auth.domain)),
  }
}

/**
 * Хост портала без схемы.
 *
 * ⚠ SDK кладёт в `domain` результат `getTargetOrigin()`, а это ПОЛНЫЙ адрес вида
 * `https://портал.bitrix24.ru`. Наш аллоулист (`server/domain/portals/zones.ts`) проверяет
 * голый хост и на строку со схемой отвечает «не домен портала» — то есть установка
 * отбилась бы как поддельная, будучи настоящей.
 *
 * Принимаем обе формы: портал однажды может прислать и голый хост, и тогда лишний разбор
 * ничего не сломает, а отсутствующий — сломает всё.
 */
export function portalHost(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') return ''
  if (!trimmed.includes('://')) return trimmed.replace(/\/.*$/, '').toLowerCase()

  try {
    return new URL(trimmed).hostname.toLowerCase()
  }
  catch {
    return ''
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
