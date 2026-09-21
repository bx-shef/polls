/**
 * A portal refusal with its machine code kept apart from its prose.
 *
 * ⚠ Существует потому, что SDK их СКЛЕИВАЕТ не в ту сторону. Проверено в исходнике
 * `@bitrix24/b24jssdk` 2.2.0: `SdkError` кладёт машинный код в собственное поле `code`,
 * а `message` собирает из `formatErrorMessage`, которая возвращает РОВНО `description` —
 * человеческую фразу портала и больше ничего. `Result.getErrorMessages()` отдаёт только
 * `message`, то есть код теряется безвозвратно.
 *
 * Пока `server/b24/client.ts` бросал `new Error(getErrorMessages().join('; '))`, наверх
 * приезжала одна проза. А `safeRefusal` искал в ней машинные коды подстрокой — и не находил,
 * потому что в описаниях их нет: у `NO_AUTH_FOUND` описание «Wrong authorization data»,
 * у `PORTAL_DELETED` — «Portal was deleted». Документация Битрикс24 говорит про это прямо:
 * «Сервер авторизации возвращает код ошибки в поле `error`, а пояснение — в поле
 * `error_description`», и велит ветвиться по коду.
 *
 * Цена была не теоретической. `inbox.last_error` с PR #22 писал «код не распознан» почти
 * на любой настоящий отказ, а распознавание мёртвого гранта (PR #34) не могло сработать
 * ни разу: фича выглядела здоровой и не делала ничего. Нашла панель ревью PR #34, причём
 * тесты этого не ловили — они были собраны на самодельных `new Error('КОД: текст')`,
 * форме, которой SDK не производит.
 *
 * ⚠ Класс живёт в доменном слое, а не рядом с клиентом: по нему ветвятся чистые функции
 * (`safeRefusal`, `isDeadGrant`), а домену запрещено знать про `server/b24/`.
 */
export class PortalError extends Error {
  /** Машинный код из поля `error` ответа портала. Пусто — портал его не прислал. */
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'PortalError'
    this.code = code
  }
}

/**
 * Достать машинный код отказа, если он есть.
 *
 * ⚠ Только из `PortalError`. Выковыривать `.code` из произвольного объекта нельзя:
 * туда попадёт `code` системной ошибки Node (`ECONNREFUSED`, `ETIMEDOUT`) и любой
 * чужой объект с таким полем, а на этом коде принимаются необратимые решения.
 */
export function refusalCode(error: unknown): string {
  return error instanceof PortalError ? error.code : ''
}
