/**
 * Какой портал обслуживает ПУБЛИЧНЫЙ запрос (#49).
 *
 * ⚠️ Это главный вопрос мультитенанта, и до сих пор его просто не было. Пока портал один, стор
 * выбирался на процесс (`ensureDefaultPortal`), и все роуты молча писали в него. С несколькими
 * порталами так нельзя: `/s/:key` и `POST /api/submit` **анонимны**, у них нет ни фрейма, ни
 * события портала, а ключ опроса у разных порталов совпадает штатно — `csat_postdeal` заводит себе
 * каждый. Выбрать «первый попавшийся» значит показать клиенту одного заказчика анкету другого и
 * записать ответ не туда.
 *
 * Правило из двух ступеней:
 *  1. **Есть токен приглашения — он и есть ключ тенанта.** Токен глобально уникален (`randomUUID`,
 *     122 бита) и лежит в строке приглашения вместе с `portal_id`. Это авторитетный ответ.
 *  2. **Токена нет** (публичная ссылка на опрос без приглашения) — обслуживаем, только если ключ
 *     опубликован РОВНО ОДНИМ порталом. Иначе отказываем: угадывать тут нечего, а «показали не ту
 *     анкету» — отказ, который человек не заметит.
 */
import type { Queryable } from './types'

export type TenantResolution =
  /** Портал определён однозначно. */
  | { kind: 'portal'; portalId: number }
  /** Ключ опубликован несколькими порталами, а токена нет — выбирать наугад нельзя. */
  | { kind: 'ambiguous'; count: number }
  /** Ни один портал такого не публиковал (либо токен не найден). */
  | { kind: 'unknown' }

/**
 * Портал по хешу токена приглашения — авторитетный путь.
 *
 * ⚠️ Ищем по ХЕШУ, а не по токену: в базе лежит только он (#4). Поиск идёт по ВСЕМ порталам —
 * в этом и смысл: до резолва мы ещё не знаем, чей это токен. Уникальный индекс по хешу делает
 * ответ однозначным.
 */
export async function portalByInvitationToken(db: Queryable, tokenHash: string): Promise<number | undefined> {
  const r = await db.query<{ portal_id: number }>(
    'select portal_id from invitation where token_hash = $1 limit 1',
    [tokenHash]
  )
  return r.rows[0]?.portal_id
}

/**
 * Портал по ключу опроса — путь БЕЗ токена.
 *
 * ⚠️ Считаем порталы, а не берём первый: `limit 2` отвечает на вопрос «однозначно ли» дешевле, чем
 * полный `count(*)`, и этого достаточно — нам важно только «один или больше одного».
 *
 * Учитываются лишь ОПУБЛИКОВАННЫЕ опросы (есть версия): черновик наружу не отдаётся, и портал с
 * одним черновиком не должен делать чужой опубликованный ключ неоднозначным.
 */
export async function portalBySurveyKey(db: Queryable, surveyKey: string): Promise<TenantResolution> {
  const r = await db.query<{ portal_id: number }>(
    `select distinct g.portal_id
       from survey s
       join survey_group g on g.id = s.group_id
      where s.survey_key = $1
        and exists (select 1 from survey_version v where v.survey_id = s.id)
      limit 2`,
    [surveyKey]
  )
  if (r.rows.length === 0) return { kind: 'unknown' }
  if (r.rows.length > 1) return { kind: 'ambiguous', count: r.rows.length }
  return { kind: 'portal', portalId: r.rows[0]!.portal_id }
}
