import { callMethod, type PortalClient } from './client'
import { crmContextSchema, type CrmContext } from '../domain/schema'

/**
 * Обогащение снимка CRM ИМЕНАМИ (компания, направление, ответственный).
 *
 * ⚠️ Зачем это вообще нужно. `dealToCrmContext` кладёт в снимок только идентификаторы, и до этого
 * модуля `companyName`/`dealCategoryName`/`responsibleName` заполнялись **лишь в демо-сиде**. На живом
 * портале три среза дашборда из четырёх показывали бы `#9`, `#0`, `#1`: срез технически работает, а
 * прочитать его нельзя — то есть половина того, ради чего дашборд открывают, не работает. Товары были
 * исключением: `productName` приезжает вместе с товарными строками и в снимок попадал.
 *
 * ⚠️ **Имена — СНИМОК на момент выписки приглашения, а не ссылка на справочник.** Переименовали
 * компанию в CRM — в старых ответах останется прежнее имя, и это правильно: срез показывает, как
 * называлось то, что оценивали. Ровно поэтому имя и лежит в `context`, а не резолвится на чтении.
 *
 * ⚠️ **Спрашивается ТОЛЬКО там, где приглашение уже точно выписывается.** На событийном пути снимок
 * строится раньше дешёвого гейта «а запускает ли эта стадия опросы», и обогащение в той точке стоило бы
 * трёх запросов к порталу на КАЖДОЕ изменение любой сделки — та же ошибка, от которой в
 * `runDealUpdate` отдельно защищён `crm.stagehistory.list`.
 */
export interface CrmNames {
  companyName?: string
  dealCategoryName?: string
  responsibleName?: string
}

/** Кап схемы (`crmContextSchema`): длиннее — обрезаем сами, чтобы не ронять запись ответа. */
const MAX_NAME = 500

/** Непустая строка после обрезки, иначе `undefined`: пустое имя хуже, чем честный `#id`. */
function clean(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim().slice(0, MAX_NAME)
  return s.length > 0 ? s : undefined
}

/**
 * Слить имена в снимок. Чистая функция: результат заново валидируется схемой — снимок уходит в базу и
 * в дело таймлайна, и мусор из CRM не должен доехать ни туда, ни туда.
 *
 * Имя, которого нет, поле НЕ создаёт: `undefined` в снимке и отсутствие поля для среза одно и то же
 * (`coalesce(..., '#' || id)`), а пустая строка сломала бы фолбэк.
 */
export function withCrmNames(ctx: CrmContext, names: CrmNames): CrmContext {
  const companyName = clean(names.companyName)
  const dealCategoryName = clean(names.dealCategoryName)
  const responsibleName = clean(names.responsibleName)
  return crmContextSchema.parse({
    ...ctx,
    ...(companyName !== undefined ? { companyName } : {}),
    ...(dealCategoryName !== undefined ? { dealCategoryName } : {}),
    ...(responsibleName !== undefined ? { responsibleName } : {})
  })
}

/** ФИО сотрудника из ответа `user.get`. Берём ТОЛЬКО имя и фамилию — см. предупреждение ниже. */
function userName(row: Record<string, unknown> | undefined): string | undefined {
  if (!row) return undefined
  return clean([row.NAME, row.LAST_NAME].filter((v) => typeof v === 'string' && v.trim()).join(' '))
}

/**
 * Спросить у портала три имени. Каждое — независимо и fail-open: не ответил портал по компании,
 * имена направления и ответственного всё равно приедут.
 *
 * ⚠️ **`user.get` отдаёт МНОГО** (фото, дата рождения, подразделение, часовой пояс, телефон). В снимок
 * берём только имя и фамилию: остальное — персональные данные сотрудника, которые нам не нужны ни для
 * одного среза, а попав в `context`, они уехали бы в базу, в тело дела и под срок хранения.
 *
 * ⚠️ **Воронка 0 не возвращается методом `crm.dealcategory.list`** (проверено вживую) — у неё свой
 * метод `crm.dealcategory.default.get`. Без этой ветки самый частый случай (портал с одной воронкой)
 * остался бы без имени, то есть обогащение молча не работало бы у большинства.
 */
export async function fetchCrmNames(client: PortalClient, ctx: CrmContext): Promise<CrmNames> {
  const ask = async <T>(fn: () => Promise<T>): Promise<T | undefined> => fn().catch(() => undefined)

  const [company, category, user] = await Promise.all([
    ctx.companyId == null
      ? undefined
      : ask(() => callMethod<Record<string, unknown>>(client, 'crm.company.get', { id: ctx.companyId })),
    ctx.dealCategoryId == null
      ? undefined
      : ask(() =>
          ctx.dealCategoryId === 0
            ? callMethod<Record<string, unknown>>(client, 'crm.dealcategory.default.get', {})
            : callMethod<Record<string, unknown>>(client, 'crm.dealcategory.get', { id: ctx.dealCategoryId })
        ),
    ctx.responsibleId == null
      ? undefined
      : ask(() => callMethod<Array<Record<string, unknown>>>(client, 'user.get', { ID: ctx.responsibleId }))
  ])

  const companyName = clean(company?.TITLE)
  const dealCategoryName = clean(category?.NAME)
  const responsibleName = userName(Array.isArray(user) ? user[0] : undefined)
  return {
    ...(companyName !== undefined ? { companyName } : {}),
    ...(dealCategoryName !== undefined ? { dealCategoryName } : {}),
    ...(responsibleName !== undefined ? { responsibleName } : {})
  }
}
