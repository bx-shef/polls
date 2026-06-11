import { z } from 'zod'

/**
 * Keyset-пагинация: курсор — opaque base64url-токен ключа (submittedAt, id).
 * Семантика курсора store-specific (Memory сравнивает строки, Pg — `(timestamptz, bigint)`),
 * для вызывающего это непрозрачный токен «следующей страницы».
 */
export interface Keyset {
  submittedAt: string
  id: string
}

const keysetSchema = z.object({
  submittedAt: z.string().datetime({ offset: true }),
  id: z.string().min(1).max(200)
})

export function encodeCursor(k: Keyset): string {
  return Buffer.from(JSON.stringify(k), 'utf8').toString('base64url')
}

/**
 * Декодирует И ВАЛИДИРУЕТ курсор. На битом/подделанном курсоре — понятная ошибка
 * (чтобы HTTP-слой вернул 400, а не упал с 500 на JSON.parse или касте в SQL).
 */
export function decodeCursor(cursor: string): Keyset {
  let raw: unknown
  try {
    raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new Error('Невалидный курсор пагинации')
  }
  const parsed = keysetSchema.safeParse(raw)
  if (!parsed.success) throw new Error('Невалидный курсор пагинации')
  return parsed.data
}

// Сравнение id numeric-aware («r2» < «r10»), консистентно в keysetCmp и afterKeyset
// (иначе сортировка и фильтр курсора могли разойтись → пропуск/дубль записей).
function cmpId(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true })
}

/** Сортировка по (submittedAt, id): сначала дата, при равенстве — id (уникален в сторе). */
export function keysetCmp(a: Keyset, b: Keyset): number {
  const byDate = a.submittedAt.localeCompare(b.submittedAt)
  return byDate !== 0 ? byDate : cmpId(a.id, b.id)
}

/** Строго «после» курсора по тому же ключу (submittedAt, id). */
export function afterKeyset(r: Keyset, c: Keyset): boolean {
  const byDate = r.submittedAt.localeCompare(c.submittedAt)
  return byDate !== 0 ? byDate > 0 : cmpId(r.id, c.id) > 0
}
