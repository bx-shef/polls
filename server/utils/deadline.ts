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

/**
 * То же, но для работы, у которой есть РЕЗУЛЬТАТ: не успела к сроку — отдаём запасное значение.
 *
 * ⚠️ Заведено после ревью #198. Там страховочный `crm.activity.list` стоит НА КРИТИЧЕСКОМ ПУТИ перед
 * созданием приглашения, а `.catch(() => 0)` закрывает только мгновенный отказ. Портал так не
 * отказывает: у клиента Bitrix24 свой таймаут ~30 секунд, до трёх повторов и backoff, то есть один
 * вызов тянется минутами. Событийный роут ждёт всю работу до отдачи 200 — значит подтормаживающий
 * портал съедал бы не страховку, а САМУ ДОСТАВКУ, и клиента не спросили бы вовсе. Ровно тот исход,
 * который решение fail-open объявляет худшим.
 *
 * ⚠️ Работа НЕ отменяется (у REST-клиента нет отмены) — она доигрывает в фоне, а мы уходим с
 * запасным значением. Поэтому её отказ обязан быть проглочен здесь: иначе после ответа всплывёт
 * unhandled rejection.
 */
export async function valueByDeadline<T>(
  work: Promise<T>,
  ms: number,
  fallback: T,
  onTimeout: () => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<typeof TIMEOUT>((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), ms) })
  // Отказ доигрывающей работы гасим: наружу он уже не нужен, а unhandled rejection — нужен ещё меньше.
  work.catch(() => undefined)
  try {
    const r = await Promise.race([work, deadline])
    if (r === TIMEOUT) {
      onTimeout()
      return fallback
    }
    return r
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Часовой уникален по ссылке — значение работы с ним не совпадёт, каким бы оно ни было. */
const TIMEOUT = Symbol('deadline')
