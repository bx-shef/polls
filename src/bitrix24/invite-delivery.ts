/**
 * Доставка приглашения через дело в таймлайне сделки — и это же дело отвечает на вопрос «уже
 * приглашали?» (#126 вместе с #138).
 *
 * **Почему признак живёт в CRM, а не у нас.** Дело всё равно создаётся доставкой, его видит человек в
 * карточке сделки, и оно переживает что угодно на нашей стороне. Отметка в своей базе была бы
 * параллельной бухгалтерией того же факта — невидимой никому, включая владельца портала. Решение и
 * прецедент (`ai-price-import`, где локальный чекпоинт удалили ровно так же) — карта проекта.
 *
 * **Почему одного маркера мало.** Проверено на живом портале: два дела с ОДИНАКОВЫМ `ORIGIN_ID`
 * создаются рядом без единой жалобы — Bitrix24 уникальность маркера не форсит. Маркер отвечает за то,
 * чтобы ключ не совпал СЛУЧАЙНО с чужим; за то, чтобы мы сами не записали дважды, отвечает наш код:
 * «поиск → создание» идёт под очередью по ключу (`createKeySerializer`).
 */
import type { KeySerializer } from '../api/serial-by-key'

/** Код приложения в маркере. Отделяет наши дела от чужих, если ключи вдруг совпадут по форме. */
export const INVITE_ORIGINATOR = 'bx-shef.polls'

export interface InviteMarker {
  originatorId: string
  originId: string
}

/**
 * Маркер дела-приглашения: код приложения + ключ перехода и опроса.
 *
 * `transitionId` — `ID` записи истории стадий (`stage-transition.ts`): уникален и стабилен для одного
 * перехода, поэтому вся гроздь событий вокруг него видит одно значение. `surveyKey` обязателен — один
 * переход может запускать несколько опросов, и каждый заслуживает своё приглашение.
 *
 * Не пара «сделка + стадия»: сделка может ВЕРНУТЬСЯ в ту же стадию, и это законный повод спросить
 * клиента снова — по такому ключу второй заход навсегда съедался бы как дубль.
 */
export function inviteMarker(transitionId: string, surveyKey: string): InviteMarker {
  return { originatorId: INVITE_ORIGINATOR, originId: `stage:${transitionId}:${surveyKey}` }
}

/**
 * Наше ли это дело и по ТОМУ ли опросу — по одному лишь `ORIGIN_ID`, без ключа перехода.
 *
 * ⚠️ Нужно закрытию дела при получении ответа ([#177](https://github.com/bx-shef/polls/issues/177)):
 * там известны сделка и опрос, но НЕ переход — клиент отвечает по ссылке, а ключ перехода живёт
 * только в событийном пути. Поэтому дела ищутся по владельцу и коду приложения, а «тот ли опрос»
 * решается уже здесь, разбором маркера.
 *
 * Разбор, а не `endsWith(':' + surveyKey)`: ключ опроса — произвольная строка, и `csat` совпал бы
 * хвостом с `nps_csat`. Форма маркера ровно одна (`stage:<переход>:<опрос>`), её и разбираем.
 */
export function markerMatchesSurvey(originId: string | undefined, surveyKey: string): boolean {
  if (originId === undefined) return false
  const parts = originId.split(':')
  return parts.length === 3 && parts[0] === 'stage' && parts[2] === surveyKey
}

/** Дело, каким его отдаёт поиск по маркеру: нужен только id и признак закрытости. */
export interface MarkedActivity {
  id: number
  completed: boolean
}

export type InviteDecision =
  /** Приглашения по этому переходу ещё не было (или прошлое закрыто без ответа) — выписываем. */
  | { action: 'create' }
  /** Дело висит открытым: ссылка отправлена, ждём клиента. Это и есть отсечённая гроздь. */
  | { action: 'skip'; reason: 'open' }
  /** Дело закрыто И клиент ответил после перехода — цикл завершён. */
  | { action: 'skip'; reason: 'answered' }

export interface InviteDecisionInput {
  /** Дела, найденные по маркеру (наши, этого перехода и опроса). */
  activities: readonly MarkedActivity[]
  /**
   * Ответил ли клиент по этой сделке и опросу ПОСЛЕ момента перехода.
   *
   * ⚠️ Именно «после перехода», а не «вообще»: сделка может пройти стадию второй раз, и старый ответ
   * не должен закрывать новый повод спросить. Момент перехода известен из той же записи истории, что
   * дала ключ, — поэтому ничего дополнительно хранить не нужно.
   */
  answeredAfterTransition: boolean
}

/**
 * Правило владельца, целиком: открыто — молчим; закрыто и отвечено — молчим; закрыто без ответа —
 * зовём снова; ничего нет — зовём.
 *
 * Чистая функция: решение принимается без единого обращения к порталу и проверяется таблицей.
 */
export function decideInvite(input: InviteDecisionInput): InviteDecision {
  if (input.activities.some((a) => !a.completed)) return { action: 'skip', reason: 'open' }
  // Дело закрыто И клиент ответил после перехода — цикл завершён, новый опрос будет новым поводом.
  if (input.activities.length > 0 && input.answeredAfterTransition) return { action: 'skip', reason: 'answered' }
  // Сюда падают два случая: дел нет вовсе и дела есть, но все закрыты без ответа. Второй — законный
  // повод позвать снова: «закрыто» значит, что менеджер снял задачу с себя, а не что клиента спросили.
  return { action: 'create' }
}

export interface DeliverInviteDeps {
  /** Найти НАШИ дела по маркеру (`crm.activity.list`, фильтр по `ORIGINATOR_ID`+`ORIGIN_ID`). */
  findByMarker: (marker: InviteMarker) => Promise<MarkedActivity[]>
  /** Отвечал ли клиент по этой сделке и опросу после перехода — чтение НАШИХ ответов, не портала. */
  answeredAfterTransition: () => Promise<boolean>
  /**
   * Создать приглашение и дело в таймлайне; вернуть id дела. Внутри — выписка токена и
   * `crm.activity.configurable.add` с маркером.
   */
  createInvite: (marker: InviteMarker) => Promise<number>
  /**
   * Убедиться, что маркер на созданном деле действительно стоит, и доставить его, если нет.
   *
   * ⚠️ Не перестраховка. `crm.activity.configurable.add` недоступен вебхуку
   * (`ERROR_WRONG_CONTEXT`, его нет даже в списке методов), поэтому принимает ли он поля маркера в
   * своём `fields` — на сегодня непроверяемо, и станет известно только на установленном приложении.
   * Ставка на «примет» дорогая: не примет — поиск не найдёт дело, и следующее событие грозди создаст
   * второе. Поэтому маркер после создания СВЕРЯЕТСЯ, а при отсутствии — дописывается
   * `crm.activity.update`. На портале, где `fields` маркер принимает, эта ветка не срабатывает ни
   * разу; какая ветка сработала — видно в логе, то есть первый же прогон даёт ответ.
   */
  ensureMarker: (activityId: number, marker: InviteMarker) => Promise<MarkerFix>
  /** Очередь по ключу: «поиск → создание» не должно идти внахлёст с самим собой. */
  serializer: KeySerializer
  /**
   * Префикс ключа очереди — портал (`member_id`).
   *
   * ⚠️ Не косметика: ID записей истории стадий у каждого портала свои и мелкие, поэтому ключи двух
   * порталов совпадают штатно. Без префикса медленный REST одного портала держал бы очередь другого.
   */
  serialKeyPrefix?: string
}

/**
 * Чем кончилась сверка маркера на созданном деле:
 * `already` — `configurable.add` принял поля маркера сам; `repaired` — не принял, дописали и ПЕРЕЧИТАЛИ,
 * маркер на месте; `failed` — дописали, но перечитывание маркера не показало.
 *
 * ⚠️ `failed` — не мелочь: такое дело поиск по маркеру не найдёт, и следующее событие грозди создаст
 * второе приглашение. Раньше эта ветка была неотличима от `repaired` (успехом считался сам факт вызова
 * `crm.activity.update`, а не результат), то есть провал защиты выглядел бы в логе как её работа.
 */
export type MarkerFix = 'already' | 'repaired' | 'failed'

/**
 * Видно ли только что созданное дело в поиске по маркеру.
 *
 * ⚠️ Это ЕДИНСТВЕННАЯ проверка того, что защита от дублей вообще работает. Вживую подтверждено, что
 * `crm.activity.list` фильтрует по маркеру на ОБЫЧНОМ деле; настраиваемое дело вебхуком не создать
 * (`ERROR_WRONG_CONTEXT`), поэтому «видит ли `list` настраиваемые дела» до установки неизвестно. Если
 * не видит — дедуп не работает вовсе, а лог без этой проверки показывал бы ровное `markerFix: already`,
 * то есть «всё хорошо» при 2–4 письмах клиенту.
 *
 * `unknown` — сам запрос не удался (портал недоступен, лимит): вердикта нет, и выдавать его за `no`
 * нельзя.
 */
export type MarkerVisible = 'yes' | 'no' | 'unknown'

export type DeliverOutcome =
  | {
      kind: 'created'
      activityId: number
      marker: InviteMarker
      markerFix: MarkerFix
      markerVisible: MarkerVisible
    }
  | { kind: 'skipped'; reason: 'open' | 'answered'; marker: InviteMarker }

/**
 * Полный путь одного приглашения: под очередью по ключу — найти свои дела → решить по правилу →
 * при необходимости создать и убедиться в маркере.
 *
 * ⚠️ Очередь охватывает ВЕСЬ путь, а не только создание: промежуток между «нашёл» и «создал» — ровно
 * то место, где гроздь событий проскакивала бы дважды.
 */
export async function deliverInvite(
  transitionId: string,
  surveyKey: string,
  deps: DeliverInviteDeps
): Promise<DeliverOutcome> {
  const marker = inviteMarker(transitionId, surveyKey)
  const serialKey = deps.serialKeyPrefix !== undefined ? `${deps.serialKeyPrefix}:${marker.originId}` : marker.originId
  return deps.serializer.run(serialKey, async () => {
    const activities = await deps.findByMarker(marker)
    // Ответы спрашиваем ТОЛЬКО когда это может изменить решение: открытое дело закрывает вопрос само.
    const answeredAfterTransition = activities.some((a) => !a.completed)
      ? false
      : activities.length > 0 && (await deps.answeredAfterTransition())
    const decision = decideInvite({ activities, answeredAfterTransition })
    if (decision.action === 'skip') return { kind: 'skipped', reason: decision.reason, marker }
    const activityId = await deps.createInvite(marker)
    const markerFix = await deps.ensureMarker(activityId, marker)
    // Контрольный поиск — тем же запросом, на котором стоит вся защита. Стоит один REST-вызов и только
    // на редком пути создания; ошибку глушим намеренно: приглашение уже выписано, и ронять доставку
    // из-за неудавшейся ПРОВЕРКИ значило бы потерять сделанную работу.
    const markerVisible: MarkerVisible = await deps
      .findByMarker(marker)
      .then((found): MarkerVisible => (found.some((a) => a.id === activityId) ? 'yes' : 'no'))
      .catch((): MarkerVisible => 'unknown')
    return { kind: 'created', activityId, marker, markerFix, markerVisible }
  })
}
