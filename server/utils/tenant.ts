// Какой портал обслуживает запрос (#47/#49) — Nitro-обвязка над ядровыми резолверами.
//
// ⚠️ До мультитенанта вопроса не было: портал один, стор выбран на процесс (`ensureDefaultPortal`),
// и все роуты молча писали и читали в него. Порталов больше одного — и тот же код означает, что
// клиент одного заказчика видит анкету другого, а сотрудник одного заказчика — срезы другого, с
// именами клиентов и ответственных. Снаружи оба отказа не видны: страница рисуется, ответ «принят».
//
// Входов ДВА, и вопросы у них разные:
//  - ПУБЛИЧНЫЙ (`/s/:key`, `POST /api/submit`) — анонимен: ни фрейма, ни сессии. Портал выводится
//    из токена приглашения, а без токена — из ключа опроса, и только если ответ однозначен.
//  - ФРЕЙМОВЫЙ (дашборд, админка) — портал уже доказан подписанной сессией; остаётся перевести
//    `member_id` в числовой `portal.id`, которым скоуплен стор.
import { portalByInvitationToken, portalBySurveyKey, type TenantResolution } from '~core/store/tenant'
import { hashToken } from '~core/store/pg-invitation'
import { portalIdByMemberId } from '~core/bitrix24/portal'
import { DEV_PORTAL_ID, type PortalSession } from '~core/api/session'
import type { InvitationStore } from '~core/api/invitation'
import type { IStore } from '~core/store/types'
import { usePortalDb, useStore, useInvitations, storeFor, invitationsFor, logger } from './api'

/**
 * Итог резолва тенанта для публичного запроса.
 *
 * `portalId: undefined` при `ok` — это НЕ отказ, а «портала нет вовсе»: режим памяти (dev/демо, без
 * `DATABASE_URL`) либо ключ, которого не публиковал никто. В обоих случаях вызывающий работает с
 * общим стором ровно как до мультитенанта, и ядро само отвечает «опрос не найден».
 */
export type PublicTenant =
  | { ok: true; portalId: number | undefined }
  | { ok: false; reason: 'ambiguous' }

/**
 * Портал для публичного запроса: токен авторитетнее ключа.
 *
 * ⚠️ Порядок ступеней не случаен. Токен приглашения глобально уникален (122 бита) и лежит в строке
 * рядом с `portal_id` — это ТОЧНЫЙ ответ. Ключ опроса точным быть не может по построению: уникальность
 * в схеме — `(group_id, survey_key)`, то есть `csat_postdeal` заводит себе каждый портал. По ключу
 * обслуживаем, только когда опубликовавший его портал ровно один.
 *
 * ⚠️ Токен ПРИСЛАН, но не найден — это не повод отказывать: падаем в поиск по ключу. Хеш токена
 * уникален глобально, «не найден» значит «не найден ни у кого», и любой портал ответит одно и то же —
 * «срок истёк или опрос уже пройден». Отказать здесь своим текстом значило бы завести второй источник
 * вердикта о ссылке, который разъедется с ядровым.
 */
export async function resolvePublicPortal(surveyKey: string, token: string | undefined): Promise<PublicTenant> {
  const db = await usePortalDb()
  if (!db) return { ok: true, portalId: undefined }

  if (token !== undefined) {
    const byToken = await portalByInvitationToken(db, hashToken(token))
    if (byToken !== undefined) return { ok: true, portalId: byToken }
  }

  const r: TenantResolution = await portalBySurveyKey(db, surveyKey)
  if (r.kind === 'portal') return { ok: true, portalId: r.portalId }
  if (r.kind === 'unknown') return { ok: true, portalId: undefined }

  // Отказ ВИДЕН в логе: иначе владелец не поймёт, почему публичная ссылка перестала открываться
  // ровно после того, как второй портал завёл опрос с тем же ключом.
  logger.warn('tenant_ambiguous', {
    surveyKey,
    // ⚠️ Формулировка про токен обтекаемая намеренно: сюда приходит и запрос БЕЗ токена, и запрос с
    // токеном, которого нет в базе. Написать «токена нет» значило бы для второго случая соврать —
    // и увести того, кто читает лог, искать поломку в сборке ссылки.
    msg: `Ключ опубликован порталами (${r.count}), а годного токена приглашения в запросе нет — выбрать нельзя (#49)`
  })
  return { ok: false, reason: 'ambiguous' }
}

/**
 * Текст отказа при неоднозначном ключе.
 *
 * ⚠️ Не называет ни число порталов, ни сам факт «такой опрос есть у нескольких заказчиков»: адрес
 * публичный, и это рассказало бы анониму о чужих установках. По правилу проекта в сообщении есть
 * ГДЕ, ЧТО и ЧТО ДАЛЬШЕ, а дальше у человека ровно один рабочий шаг — открыть личную ссылку.
 *
 * ⚠️ Строка ещё и приставляется к «Ответ не отправлен.» на `POST /api/submit`, поэтому начинается с
 * самостоятельного предложения и укладывается в предел `MAX_SERVER_MESSAGE` (300) вместе с приставкой:
 * длиннее — и клиент показал бы вместо неё общий фолбэк «проверьте подключение», уводящий в сторону.
 */
export const AMBIGUOUS_SURVEY_MESSAGE =
  'Опрос доступен только по личной ссылке. Откройте ссылку из письма или из карточки сделки — '
  + 'если её нет, попросите у менеджера.'

/**
 * То же на ОТПРАВКЕ ответа: человек уже заполнил анкету, и первое, что он должен прочесть, —
 * что ответ не ушёл.
 *
 * ⚠️ Второй константой, а не склейкой в роуте: тексты отказа собираются ТОЛЬКО литералами
 * (`test/server-message.test.ts`), иначе однажды в сообщение подставят значение из запроса. Обе
 * строки живут рядом — расхождение видно глазом в одном экране.
 */
export const AMBIGUOUS_SUBMIT_MESSAGE =
  'Ответ не отправлен. Опрос доступен только по личной ссылке. Откройте ссылку из письма или из '
  + 'карточки сделки — если её нет, попросите у менеджера.'

/** Итог резолва тенанта для запроса из фрейма (дашборд/админка). */
export type SessionTenant =
  | { ok: true; portalId: number | undefined }
  | { ok: false; status: 401 }

/**
 * Портал для запроса из фрейма: `member_id` подписанной сессии → числовой `portal.id`.
 *
 * Dev-открытый режим (авторизации нет вовсе — локальный запуск и визуальный гейт) и режим памяти
 * дают `undefined`: порталов там нет, работаем с общим стором, как раньше.
 *
 * ⚠️ Признак dev-режима выводится ЗДЕСЬ, из самой сессии (`DEV_PORTAL_ID`), а не приходит
 * параметром. Флаг, который вызывающий передаёт сам, — это второе место, где решается «есть ли
 * авторизация»; разъехавшись с первым, оно открыло бы прод-дашборд без сессии, и по коду роута это
 * читалось бы как «здесь всё проверено».
 *
 * ⚠️ Сессия валидна, а портала в базе нет → **401**, а не «показать общий стор». Подпись доказывает,
 * ЧЕЙ это портал, но не то, что портал ещё установлен: приложение могли удалить, пока сессия жива
 * (TTL до 8 ч). Фолбэк на общий стор в этот момент показал бы сотруднику удалённого заказчика данные
 * того портала, который инстанс выбрал себе по умолчанию.
 */
export async function resolveSessionPortal(session: PortalSession): Promise<SessionTenant> {
  if (session.portalId === DEV_PORTAL_ID) return { ok: true, portalId: undefined }
  const db = await usePortalDb()
  if (!db) return { ok: true, portalId: undefined }
  const portalId = await portalIdByMemberId(db, session.portalId)
  if (portalId === undefined) return { ok: false, status: 401 }
  return { ok: true, portalId }
}

/**
 * Тенант событийного пути (#49): стор и приглашения портала по его `member_id`.
 *
 * Зовётся ТОЛЬКО после того, как `member_id` подтверждён (сверка `application_token` в
 * `runDealUpdate`/`runRobotTrigger` либо `verifyFrameAuth` у виджета) — иначе выбор портала делал бы
 * недоверенный POST.
 *
 * `undefined` — портала с таким `member_id` нет. Для событийного пути это «ничего не триггерим»:
 * приложение удалили, писать приглашения некуда.
 *
 * Режим памяти (dev/демо, без `DATABASE_URL`) — общий стор: порталов там нет вовсе, и путь остаётся
 * ровно таким, каким был до мультитенанта.
 */
export interface PortalTenant {
  store: IStore
  invitations: InvitationStore
}

export async function tenantByMemberId(memberId: string): Promise<PortalTenant | undefined> {
  const db = await usePortalDb()
  if (!db) return { store: await useStore(), invitations: useInvitations() }
  const portalId = await portalIdByMemberId(db, memberId)
  if (portalId === undefined) return undefined
  return { store: await storeFor(portalId), invitations: await invitationsFor(portalId) }
}
