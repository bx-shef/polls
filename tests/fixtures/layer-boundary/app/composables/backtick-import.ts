// Нарушение намеренное: обратные кавычки вместо обычных. Гейт их однажды не видел —
// приманка стоит здесь, чтобы это не повторилось молча.
export async function loadClient() {
  return await import(`~~/server/db/client`)
}
