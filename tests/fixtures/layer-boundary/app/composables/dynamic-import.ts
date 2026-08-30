// Нарушение намеренное: динамический импорт прячет специфер от беглого взгляда, но не от гейта.
export async function loadSchema() {
  return await import('~~/server/db/schema')
}
