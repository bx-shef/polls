// Гонка «работа против дедлайна» — общая для побочных действий после записи ответа (#177, #18).
//
// ⚠️ Живёт отдельным модулем, а не копией в каждом: у обоих действий один и тот же смысл — **ответ
// клиента дороже отметки в CRM**. Разъехавшись, две копии дали бы разное поведение на самом видимом
// клиенту экране, и заметить это можно было бы только по жалобе «не отправилось» на уже записанный
// ответ.

/**
 * Ждать работу не дольше `ms`. Истёк дедлайн — отпускаем ожидающего, работа доигрывает в фоне и
 * дописывает свой исход сама.
 *
 * ⚠️ Работа обязана иметь СВОЙ `catch`: после истечения дедлайна её ждать уже некому, и отказ
 * всплыл бы unhandled rejection уже после завершения запроса.
 */
export async function withDeadline(work: Promise<void>, ms: number, onTimeout: () => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), ms) })
  try {
    if ((await Promise.race([work.then(() => 'done' as const), deadline])) === 'timeout') onTimeout()
  } finally {
    if (timer) clearTimeout(timer)
  }
}
