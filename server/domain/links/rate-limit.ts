/**
 * How often one visitor may hit the public survey page.
 *
 * Ограничение частоты — часть задачи про публичную страницу, а не «когда-нибудь потом».
 * Раньше оно жило зонами nginx и исчезло вместе с ним при переходе на общий хост: у общего
 * `nginx-proxy` свои настройки, они не наши и под наш роут не заточены. Значит считает
 * приложение.
 *
 * Считаем по ДВУМ ключам сразу, и это не перестраховка. По адресу — против перебора токенов:
 * атакующий пробует чужие ссылки с одной машины. По токену — против долбёжки в одну анкету
 * с разных адресов: токен уже известен, и защита по адресу тут не работает вовсе.
 *
 * Здесь только решение по счётчикам. Сами счётчики живут в Redis: домен не знает, где считают.
 */

/** Окно счёта. Минуты хватает: мы отсекаем перебор, а не выравниваем нагрузку. */
export const WINDOW_SECONDS = 60

/**
 * Пределы за окно.
 *
 * По адресу больше, чем по токену, намеренно: за одним адресом может сидеть целый офис
 * клиента, и несколько человек, открывших свои анкеты одновременно, — обычный день,
 * а не атака. По токену предел жёсткий: свою анкету не открывают двадцать раз в минуту.
 */
export const LIMITS = {
  perAddress: 60,
  perToken: 20,
} as const

/** Счётчики за текущее окно — сколько обращений уже было, не считая нынешнего. */
export interface RateCounters {
  perAddress: number
  perToken: number
}

export type RateDecision
  = | { allow: true }
    | { allow: false, by: 'address' | 'token', retryAfterSeconds: number }

/**
 * Пускать ли это обращение.
 *
 * ⚠ Счётчики приходят УЖЕ увеличенными на текущее обращение. Считать сначала, решать потом —
 * единственный порядок, при котором отказ тоже попадает в счёт: иначе отклонённые попытки
 * не учитываются, и перебор идёт ровно на пределе бесконечно.
 *
 * Адрес проверяется раньше токена: при переборе чужих токенов именно адрес и есть то общее,
 * что у попыток есть, и назвать в отказе стоит настоящую причину.
 */
export function decideRateLimit(
  counters: RateCounters,
  windowSeconds: number = WINDOW_SECONDS,
  limits: { perAddress: number, perToken: number } = LIMITS,
): RateDecision {
  if (counters.perAddress > limits.perAddress) {
    return { allow: false, by: 'address', retryAfterSeconds: windowSeconds }
  }
  if (counters.perToken > limits.perToken) {
    return { allow: false, by: 'token', retryAfterSeconds: windowSeconds }
  }
  return { allow: true }
}

/**
 * Ключ счётчика по адресу.
 *
 * Адрес нормализуется, потому что один и тот же клиент приходит то как `::ffff:1.2.3.4`,
 * то как `1.2.3.4`, и без этого у него оказалось бы два счёта вместо одного.
 *
 * ⚠ Адрес в ключ уходит хешем, а не как есть. IP посетителя анкеты — персональные данные
 * постороннего человека, и хранить их у себя, даже на минуту и даже в Redis, мы не обязаны:
 * для счёта достаточно различать адреса, а не знать их.
 */
export function addressKey(address: string, hash: (value: string) => string): string {
  const normalized = address.trim().toLowerCase().replace(/^::ffff:/, '')
  return `rate:addr:${hash(normalized)}`
}

/** Ключ счётчика по токену. Токен и здесь не хранится — только его хеш. */
export function tokenKey(tokenHash: string): string {
  return `rate:link:${tokenHash}`
}
