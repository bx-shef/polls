import type { ReauthOutcome } from '../domain/portals/install'

/**
 * Talks to the Bitrix24 authorization server — not to a portal.
 *
 * Сервер авторизации общий на все порталы и живёт отдельно от REST-интерфейса портала.
 * Поэтому здесь нет SDK и нет троттлинга: это не вызов метода портала, а обмен токена.
 *
 * Три решения ниже взяты у соседнего проекта (`client-bank-alfa-by`,
 * `server/utils/verifyInstallMember.ts`), где они уже проверены боем, и каждое исправляет
 * то, что документация предлагает делать иначе.
 */

/**
 * ⚠ Хост задан константой и **не берётся из запроса**.
 *
 * В гранте приезжает `server_endpoint`, и соблазн подставить его велик. Но грант на этом
 * этапе ещё ничем не подтверждён, а мы собираемся отправить туда `client_secret`
 * приложения. Фиксированный хост убирает возможность SSRF целиком, а не сужает её
 * проверкой домена: проверку можно обойти, отсутствующий параметр — нет.
 *
 * ⚠ Значение расходится с документацией. Актуальная страница про продление токенов
 * показывает `oauth.bitrix24.tech`, а в событии установки тот же адрес стоит
 * в `server_endpoint`. Здесь `oauth.bitrix.info` — адрес, на котором работает соседний
 * проект на боевых порталах и на который ходит сам SDK. По правилу проекта приоритет
 * у наблюдаемого поведения; расхождение записано в `docs/PROCESS.md` и снимается
 * первой же живой установкой (`pnpm verify:install`).
 */
const OAUTH_TOKEN_URL = 'https://oauth.bitrix.info/oauth/token/'

/**
 * ⚠ Жёсткий таймаут.
 *
 * Обработчик события держит соединение с порталом, у портала свой таймаут доставки,
 * и повторно событие установки он не пришлёт. Зависший запрос к серверу авторизации
 * не должен превращаться в зависший обработчик.
 */
const TIMEOUT_MS = 15_000

/** Документированное время жизни `access_token`, когда сервер его не назвал. */
const DEFAULT_EXPIRES_IN = 3600

/**
 * Результат объявлен в доменном слое (`ReauthOutcome`), а не здесь: решение о том, что
 * делать с установкой, принимает домен, и типы принадлежат ему. Разделение `rejected`
 * и `unavailable` — не украшение: первое означает, что грант поддельный или мёртвый,
 * второе — что мы сейчас не можем это выяснить, и лечение у них разное.
 */
/**
 * Коды, означающие «предъявленный refresh_token — не настоящий грант».
 *
 * Список намеренно узкий. Всё неперечисленное (`wrong_client` — это наша конфигурация,
 * сетевые сбои, пятисотки) уезжает в `unavailable`, то есть в сторону «повторяемо».
 * Ошибиться в эту сторону безопасно: установка всё равно не сохраняется.
 *
 * ⚠ `invalid_request` сюда НЕ входит, хотя выглядит подходящим. По документации это
 * «передан некорректно сформированный авторизационный запрос» — то есть про форму НАШЕГО
 * запроса, а не про подлинность гранта. Наш баг в сборке тела не должен превращаться
 * в вечный отказ настоящей установке.
 */
const REJECTION_CODES = new Set(['invalid_grant', 'invalid_token', 'expired_token'])

/**
 * Обменять `refresh_token` на новую пару токенов.
 *
 * Используется для двух разных вещей, и это стоит держать в голове:
 *
 * 1. **Проверка подлинности установки.** Ответ содержит `member_id`, посчитанный сервером
 *    авторизации, а не присланный нам в запросе. Совпал с тем, что пришло в событии, —
 *    значит грант настоящий; предъявить чужой `refresh_token` невозможно.
 * 2. **Продление доступа.** `access_token` живёт час, `refresh_token` — 180 дней.
 *
 * ⚠ Обмен **вращает** токен: присланный `refresh_token` после успешного вызова мёртв.
 * Сохранять надо то, что вернулось, иначе следующая попытка продлить доступ получит отказ
 * по токену, который мы сами же и потратили.
 *
 * ⚠ Документация прямо запрещает продлевать токен перед каждым вызовом и по расписанию
 * «раз в час или раз в сутки»: за это приложение блокируют автоматикой. Штатный путь —
 * дождаться `expired_token` и обменять токен по факту.
 */
export async function refreshTokens(options: {
  refreshToken: string
  clientId: string
  clientSecret: string
  /** Подменяется в тестах; в бою всегда глобальный `fetch`. */
  fetchFn?: typeof fetch
}): Promise<ReauthOutcome> {
  // ⚠ Секреты едут в теле POST, а не в query. Документация показывает GET со всеми
  // параметрами в адресе — а адрес попадает в access-лог прокси, в Referer и в историю.
  // Тело не попадает никуда.
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: options.clientId,
    client_secret: options.clientSecret,
    refresh_token: options.refreshToken,
  }).toString()

  let raw: unknown
  try {
    const response = await (options.fetchFn ?? fetch)(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept': 'application/json' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    raw = await response.json()
  }
  catch {
    // Сеть, таймаут, нечитаемый JSON — мы не знаем, настоящий грант или нет.
    return { ok: false, kind: 'unavailable', code: 'transport' }
  }

  // Приводим к объекту ДО любых проверок ключей: сервер за кривым прокси может вернуть
  // валидный JSON-примитив, и `'error' in "строка"` бросит прямо из обработчика.
  const answer = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const accessToken = typeof answer.access_token === 'string' ? answer.access_token : ''

  if (accessToken === '') {
    const code = typeof answer.error === 'string' ? answer.error : 'malformed_response'
    return { ok: false, kind: REJECTION_CODES.has(code) ? 'rejected' : 'unavailable', code }
  }

  const memberId = typeof answer.member_id === 'string' ? answer.member_id.trim() : ''
  // Настоящий грант всегда возвращает `member_id`. Пусто — значит сверять не с чем,
  // и это «не смогли проверить», а не «подделка»: отказывать живой установке дороже.
  if (memberId === '') {
    return { ok: false, kind: 'unavailable', code: 'no_member_id' }
  }

  const expiresIn = Number(answer.expires_in)

  return {
    ok: true,
    tokens: {
      accessToken,
      // Вернулся новый — берём его. Не вернулся — остаётся прежний, но это повод
      // насторожиться: штатно сервер всегда вращает токен.
      refreshToken: typeof answer.refresh_token === 'string' && answer.refresh_token !== ''
        ? answer.refresh_token
        : options.refreshToken,
      memberId,
      expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_EXPIRES_IN,
      // Сервер авторизации отдаёт `scope` через запятую, событие установки — через пробел.
      scope: typeof answer.scope === 'string' ? answer.scope.split(/[\s,]+/).filter(Boolean) : [],
      clientEndpoint: typeof answer.client_endpoint === 'string' ? answer.client_endpoint : '',
    },
  }
}
