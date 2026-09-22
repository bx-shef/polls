import type { LegacyFieldLabel, LegacyOption } from './legacy-templates'

/**
 * Reads the four query results the operator exports from the source database.
 *
 * ⚠ ЖИВЁТ В ДОМЕНЕ, А НЕ В СКРИПТЕ, и это не про красоту слоёв. Разбор снимка — самое
 * опасное место всего переноса: «молча не тот кусок» здесь значит запись чужих данных
 * в портал клиента. В скрипте с `process.exit` и верхнеуровневым `await` его нельзя ни
 * покрыть тестом, ни проверить `pnpm typecheck`. Нашли двое проверяющих независимо.
 *
 * Формат — то, что отдаёт консоль MySQL: четыре результата подряд в одном текстовом файле,
 * у каждого своя строка заголовков колонок, дальше строки через табуляцию.
 */

/** Разобранный снимок: настройки модуля и подписи полей. Остальные два запроса пока не нужны. */
export interface Snapshot {
  options: LegacyOption[]
  labels: LegacyFieldLabel[]
}

/** Колонки запроса 1 (`b_option`) — по ним узнаётся его заголовок. */
const OPTIONS_COLUMNS = ['name', 'value']

/** Колонки запроса 2 (подписи полей). */
const LABELS_COLUMNS = ['source_table', 'field', 'user_type', 'mandatory', 'multiple', 'sort', 'title']

/**
 * Найти результат запроса по СОСТАВУ КОЛОНОК, а не по готовой строке заголовка.
 *
 * ⚠ Разделитель в заголовке и в данных может не совпадать, и это не выдумка: в выгрузке
 * заказчика заголовки идут через ПРОБЕЛ, а строки данных через ТАБУЛЯЦИЮ. Сравнивая
 * заголовок как готовую строку, мы привязались бы к одному из двух вариантов — и на первой
 * же выгрузке из другой консоли разбор не нашёл бы ничего, сказав «файл неполный» о полном
 * файле. Двое проверяющих указали на это независимо, каждый предполагая свой вариант
 * разделителя, — что само по себе лучшее доказательство, что угадывать здесь нельзя.
 *
 * ⚠ По номерам строк не ищем ни при каких обстоятельствах: номера съедут от одной лишней
 * пустой строки, и разбор молча возьмёт соседний результат.
 */
export function readSection(lines: readonly string[], columns: readonly string[]): string[][] {
  const at = lines.findIndex(line => sameColumns(line, columns))
  if (at === -1) return []

  const rows: string[][] = []
  for (const line of lines.slice(at + 1)) {
    // Результат кончается там, где начинается следующий запрос или комментарий к нему.
    if (line.startsWith('--') || line.trimStart().startsWith('SELECT')) break
    if (line.trim() === '') continue
    // ⚠ `\r` обрезается у КАЖДОГО поля, а не только у строки: источник лежит в MySQL
    // с виндовыми переводами строк, и невидимый символ уезжает в последнюю колонку.
    rows.push(line.split('\t').map(cell => cell.replace(/\r$/, '')))
  }
  return rows
}

/** Та же строка колонок, каким бы пробельным символом их ни разделили. */
function sameColumns(line: string, columns: readonly string[]): boolean {
  const seen = line.trim().split(/\s+/)
  return seen.length === columns.length && seen.every((name, at) => name === columns[at])
}

/**
 * Разобрать снимок целиком.
 *
 * Пустые списки — не ошибка разбора, а факт, о котором обязан судить вызывающий: он знает,
 * можно ли продолжать без подписей полей (нельзя — см. `scripts/migrate-templates.ts`).
 */
export function readSnapshot(text: string): Snapshot {
  const lines = text.split('\n')

  return {
    options: readSection(lines, OPTIONS_COLUMNS).map(r => ({ name: r[0] ?? '', value: r[1] ?? '' })),
    labels: readSection(lines, LABELS_COLUMNS).map(r => ({
      template: (r[0] ?? '').replace('sh_qest_h_', ''),
      field: r[1] ?? '',
      title: r[6] ?? '',
    })),
  }
}
