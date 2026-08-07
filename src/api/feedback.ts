import type { IssuePayload } from '../domain/feedback'

/**
 * Канал обратной связи: настройки и отправка. **SERVER-ONLY** — здесь токен, поэтому модуль лежит в
 * `src/api` (этот сегмент граница `~core` клиенту не отдаёт).
 *
 * **Fail-closed по репозиторию — намеренно.** Репозиторий-приёмник не дефолтится ни на что: в отзыве
 * лежит свободный текст сотрудника, и он не должен попасть в публичный репозиторий с кодом. Не задан
 * или задан неверно → канал выключен: виджет скрыт, `POST` отвечает 503. Канал включается, только когда
 * заданы ОБЕ переменные; нет любой из них — выключен.
 *
 * **Приватность приёмника проверяется вживую** (`assertPrivateRepo`) перед первой отправкой: одна
 * опечатка в настройке (`bx-shef/polls` — наш ПУБЛИЧНЫЙ репозиторий с кодом) отправила бы свободный
 * текст сотрудника в открытый интернет. Формат `owner/repo` такую ошибку не ловит, а комментарий в
 * `.env` — не контроль. Не удалось убедиться, что репозиторий приватный → канал молчит (fail-closed).
 */

// Сегменты `.`/`..` отвергаем: в адресе GitHub они увели бы запрос на другой путь.
const REPO_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/
const isRepoRef = (repo: string): boolean => {
  const parts = repo.split('/')
  return parts.length === 2 && parts.every((s) => REPO_SEGMENT.test(s))
}

export interface FeedbackConfig {
  token: string
  /** `владелец/репозиторий` ПРИВАТНОГО репозитория-приёмника. */
  repo: string
}

/** Настройки канала из окружения либо `null` (канал выключен или настроен неверно). */
export function resolveFeedbackConfig(env: Record<string, string | undefined> = process.env): FeedbackConfig | null {
  const token = (env.GITHUB_FEEDBACK_TOKEN ?? '').trim()
  if (!token) return null
  const repo = (env.GITHUB_FEEDBACK_REPO ?? '').trim()
  if (!isRepoRef(repo)) return null
  return { token, repo }
}

/**
 * Убедиться, что репозиторий-приёмник ПРИВАТНЫЙ. Результат кэшируется на процесс: ответ не меняется
 * в течение жизни контейнера, а лишний запрос к GitHub на каждый отзыв не нужен.
 *
 * Fail-closed во все стороны: публичный репозиторий, нет доступа, сбой сети или неожиданный ответ —
 * все случаи дают `false`, то есть отзыв не отправляется. Лучше потерять отзыв, чем опубликовать
 * текст сотрудника в открытом доступе.
 */
export async function assertPrivateRepo(
  config: FeedbackConfig,
  fetchFn: FetchLike,
  cache: Map<string, boolean> = privateRepoCache
): Promise<boolean> {
  const cached = cache.get(config.repo)
  if (cached !== undefined) return cached
  let isPrivate = false
  try {
    const res = await fetchFn(`https://api.github.com/repos/${config.repo}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'polls-feedback',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
    if (res.status === 200) {
      const body = (await res.json().catch(() => null)) as { private?: unknown } | null
      isPrivate = body?.private === true
    }
  } catch {
    // Сбой сети — считаем непроверенным. Ошибку не включаем: она может содержать адрес.
    isPrivate = false
  }
  // Отрицательный ответ НЕ кэшируем: владелец мог просто ещё не создать репозиторий или выдать права,
  // и после починки канал должен заработать без перезапуска контейнера.
  if (isPrivate) cache.set(config.repo, true)
  return isPrivate
}

const privateRepoCache = new Map<string, boolean>()

export interface PostIssueResult {
  ok: boolean
  status: number
  /** Номер созданного issue при успехе. */
  number?: number
  /** Мог бы повтор когда-нибудь пройти (пригодится, если появится очередь отправки). */
  retryable: boolean
}

/** Минимум от fetch, который нам нужен; инжектируется в тестах. */
export type FetchLike = (url: string, init: Record<string, unknown>) => Promise<{ status: number; json(): Promise<unknown> }>

/**
 * Отправить собранный issue в GitHub.
 *
 * ⚠️ Не логируем ни токен, ни адрес, ни тело — ни при успехе, ни при ошибке. Наружу отдаём только
 * числовой статус: текст ошибки сети у undici содержит полный URL, а в нём — путь к репозиторию.
 */
export async function postFeedbackIssue(
  config: FeedbackConfig,
  payload: IssuePayload,
  fetchFn: FetchLike
): Promise<PostIssueResult> {
  let res: Awaited<ReturnType<FetchLike>>
  try {
    res = await fetchFn(`https://api.github.com/repos/${config.repo}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'polls-feedback',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify(payload)
    })
  } catch {
    // Сбой сети — временный. Ошибку не включаем: она может содержать адрес.
    return { ok: false, status: 0, retryable: true }
  }
  const status = res.status
  if (status === 201) {
    const num = await res
      .json()
      .then((j: unknown) => Number((j as { number?: unknown })?.number))
      .catch(() => Number.NaN)
    return { ok: true, status, retryable: false, ...(Number.isInteger(num) && num > 0 ? { number: num } : {}) }
  }
  // 401/403/404/422 — настройка или права: повтор не поможет. 5xx/429 — временное.
  return { ok: false, status, retryable: status >= 500 || status === 429 }
}
