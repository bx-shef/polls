/**
 * Приманка для линт-гейта (#165). НЕ тест и НЕ прод-код — материал, на котором
 * `test/lint-gate.test.ts` проверяет, что правила действительно срабатывают.
 *
 * ⚠️ Файл исключён из обычного прогона `pnpm lint` (`eslint.config.mjs`, `ignores`) — иначе он валил
 * бы гейт всегда. Тест снимает исключение флагом `--no-ignore`.
 *
 * ⚠️ Файл исключён и из корневого `tsconfig.json` — часть форм ниже ловит сам `tsc`, и `pnpm
 * typecheck` падал бы на приманке. Свой проект (`tsconfig.json` рядом) нужен, чтобы типовые правила
 * до неё всё же добирались: вне проекта TypeScript они молча вырождаются в ничто.
 *
 * У каждой формы помечено, ловит ли её компилятор. Те, где «нет», — единственная причина заводить
 * линт: именно так забытый `await` и попадает в прод.
 */

interface Store {
  peek(token: string): Promise<{ ok: boolean } | undefined>
  save(value: string): Promise<void>
}

/** `tsc` НЕ ловит. Промис отброшен: с реализацией на БД реджект стал бы unhandled rejection. */
export function dropped(store: Store): void {
  store.save('значение')
}

/** `tsc` НЕ ловит — самая опасная форма. Гард на промисе всегда ложен: «не найдено» не сработает никогда. */
export async function negativeGuard(store: Store): Promise<string> {
  const found = store.peek('токен')
  if (!found) return 'не найдено'
  return 'найдено'
}

/** `tsc` ЛОВИТ (TS2801). Оставлена, чтобы запинить `no-misused-promises`: линт обязан ловить и её. */
export function truthy(store: Store): string {
  return store.peek('токен') ? 'найдено' : 'не найдено'
}

/** `tsc` НЕ ловит (`await 42` легален). След слепой замены `.method(` → `await .method(`. */
export async function awaitOnPlainValue(): Promise<number> {
  return await 42
}

/**
 * Четвёртое правило набора (`no-control-regex`) приманкой не щупалось вовсе, и его выключение
 * оставляло гард зелёным. Регулярка с управляющим символом — ровно его предмет; в проекте это не
 * абстракция: `src/domain/text.ts` вычищает такие символы из пользовательского текста.
 */
export const CONTROL_REGEX = /[\x00-\x08]/
