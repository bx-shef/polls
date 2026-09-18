/**
 * Which OAuth scopes the app cannot work without.
 *
 * Список собран не из памяти, а из документации: у каждого метода в `b24-dev-mcp` есть поле
 * `Scope`, и оно сверено поимённо. Правило проекта требует именно этого — «права доступа
 * берутся из документации, а не из памяти», — и здесь оно окупается сразу.
 *
 * ⚠ Ловушка, ради которой файл и заведён: `userfieldconfig.add` живёт в модуле `crm`,
 * страница его документации лежит в разделе CRM, а scope у него СВОЙ — `userfieldconfig`.
 * Выдать приложению один `crm` — самая естественная ошибка при регистрации в кабинете,
 * и цена у неё несимметричная: `crm.type.add` пройдёт и создаст смарт-процесс, а следующий
 * же `userfieldconfig.add` упадёт с `insufficient_scope`. На портале останется смарт-процесс
 * без полей — при лимите 150 на весь портал на Базовом тарифе, и этот лимит не наш.
 *
 * Поэтому проверка делается ДО первого вызова: не начинать дешевле, чем остановиться
 * посередине.
 *
 * Чего в списке НЕТ и почему: `user.admin`, `app.option.get`, `app.option.set`, `profile`
 * и `app.info` — базовые, отдельного разрешения не требуют (проверено там же).
 * `bizproc` появится вместе с роботами, которых пока нет: списка «на будущее» здесь
 * не держим, это правило проекта.
 */

/**
 * Разрешения, без которых обустройство не пройдёт.
 *
 * | Что вызываем | Зачем |
 * |---|---|
 * | `crm` | `crm.type.add`, `crm.type.list`, `crm.item.*`, `crm.deal.get`, `crm.timeline.comment.add` |
 * | `userfieldconfig` | `userfieldconfig.add`, `userfieldconfig.list` — поля смарт-процессов |
 * | `placement` | `placement.bind`, `placement.unbind` — вкладка в карточке сделки |
 */
export const REQUIRED_SCOPES = ['crm', 'userfieldconfig', 'placement'] as const

export type RequiredScope = typeof REQUIRED_SCOPES[number]

/**
 * Чего не выдали.
 *
 * Сравнение регистронезависимое и с обрезкой пробелов: портал отдаёт строку разрешений
 * одним полем, мы режем её по пробелам и запятым (`server/b24/oauth.ts`), и лишний пробел
 * или заглавная буква не должны выглядеть как отсутствующее право.
 *
 * ⚠ Пустой список выданных НЕ считается «всё разрешено». Такое приходит, когда ответ
 * сервера авторизации разобрался не до конца, и трактовать это как полный доступ значит
 * пойти делать 17 вызовов вслепую.
 */
export function missingScopes(granted: readonly string[]): RequiredScope[] {
  const have = new Set(granted.map(scope => scope.trim().toLowerCase()).filter(scope => scope !== ''))
  return REQUIRED_SCOPES.filter(scope => !have.has(scope))
}
