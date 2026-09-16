import { createHash } from 'node:crypto'
import { addressKey, decideRateLimit, tokenKey, WINDOW_SECONDS, type RateDecision } from '../domain/links/rate-limit'
import { getRedis, isRedisConfigured } from '../utils/redis'

/**
 * Counts public-page hits in Redis and asks the domain what to do about it.
 *
 * Счёт здесь, решение — в домене: так предел проверяется тестом без Redis, а Redis
 * остаётся тем, чем и является, — счётчиком.
 */

/**
 * Что делать, если Redis недоступен.
 *
 * Пускаем. Ограничение частоты защищает от перебора, а не от катастрофы; отказывать всем
 * посетителям анкеты из-за того, что у НАС упал Redis, значит превратить свою аварию
 * в недоступность клиентского опроса. Отказ логируется, чтобы это не прошло незамеченным.
 */
const FAIL_OPEN: RateDecision = { allow: true }

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

/**
 * Посчитать обращение и решить, пускать ли.
 *
 * ⚠ Сначала считаем, потом решаем. Обратный порядок не учитывал бы отклонённые попытки,
 * и перебор шёл бы ровно на пределе сколько угодно долго.
 *
 * Оба счётчика инкрементируются одним конвейером: два round-trip на каждую страницу анкеты
 * — это заметно, а порядок между ними всё равно не важен.
 */
export async function countAndDecide(address: string, tokenHash: string): Promise<RateDecision> {
  if (!isRedisConfigured()) return FAIL_OPEN

  const byAddress = addressKey(address, sha256)
  const byToken = tokenKey(tokenHash)

  try {
    const redis = getRedis()
    const results = await redis
      .multi()
      .incr(byAddress)
      .expire(byAddress, WINDOW_SECONDS, 'NX')
      .incr(byToken)
      .expire(byToken, WINDOW_SECONDS, 'NX')
      .exec()

    // `exec` возвращает null, когда транзакция не выполнилась целиком. Считать это
    // нулями значило бы тихо снять ограничение.
    if (results === null) return FAIL_OPEN

    return decideRateLimit({
      perAddress: countAt(results, 0),
      perToken: countAt(results, 2),
    })
  }
  catch {
    // Молча пускаем, но не молча: вызывающий логирует. Сюда попадают только отказы
    // самого Redis — решение домена исключений не бросает.
    return FAIL_OPEN
  }
}

/**
 * Значение `INCR` из ответа конвейера.
 *
 * `EXPIRE ... NX` ставит срок только когда его ещё нет: без `NX` окно продлевалось бы
 * на каждом обращении, и счётчик активного перебора не сбрасывался бы никогда — предел
 * превратился бы в пожизненную блокировку.
 */
function countAt(results: [Error | null, unknown][], index: number): number {
  const entry = results[index]
  if (entry === undefined || entry[0] !== null) return 0
  const value = Number(entry[1])
  return Number.isFinite(value) ? value : 0
}
