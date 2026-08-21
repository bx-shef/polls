// Ручной запуск опроса из карточки сделки (#176) — Nitro-слой: ядро про REST не знает.
//
// Зачем это вообще. Виджет, открытый из карточки сделки, выписывал приглашение НАПРЯМУЮ: не смотрел,
// не висит ли уже открытое дело-приглашение по этой сделке, и сам дела не создавал. Два следствия:
//  1. **Дубль по нажатию.** Менеджер не заметил блок в таймлайне (или пролистал), открыл виджет из
//     карточки, нажал «Создать ссылку» — у клиента ДВЕ ссылки, и первая умирает, как только он
//     ответит по второй. Ровно тот дефект, от которого мы избавились на автотриггере (#138), только
//     сделанный руками.
//  2. **Невидимость.** Вторая ссылка не появлялась в таймлайне вовсе и в дедупе не участвовала: ни
//     следующее нажатие, ни закрытие при ответе (#177) о ней не знали.
//
// ⚠️ Зависимости внедряются (`manualInvite(input, deps)`), а не резолвятся внутри — тем же приёмом и
// по той же причине, что `invite-issue.ts` и `close-invite.ts`: покрытия у `server/**` нет, и модуль
// с пятью выходами обязан быть исполним в тесте.
import {
  activityConfigurableAdd, buildSurveyInviteActivity, ensureActivityMarker, findOpenInviteActivities
} from '~core/bitrix24/activity'
import { manualInviteMarker } from '~core/bitrix24/invite-delivery'
import { createSurveyInvitation } from '~core/bitrix24/trigger'
import { createKeySerializer } from '~core/api/serial-by-key'
import type { PortalClient } from '~core/bitrix24/client'
import type { InvitationStore } from '~core/api/invitation'
import type { IStore } from '~core/store/types'
import type { CrmContext } from '~core/domain/schema'
import { surveyPath } from '~core/client/invitation-link'
import { errInfo } from '~core/obs/logger'

/**
 * Кап на список id, уезжающий в исход и в лог. Дел на сделке единицы; десяток означает поломку, а не
 * нагрузку (маркер не проставился, и каждое нажатие плодит новое дело).
 *
 * ⚠️ Это НЕ «сколько показываем человеку»: наружу id не идут вовсе — см. разбор у
 * {@link ManualInviteOutcome}. Прежняя формулировка обещала показ, которого нет.
 */
export const MAX_EXISTING_IDS = 10

/**
 * Очередь «поиск → создание» — ОДНА на процесс, иначе она ничего не значит.
 *
 * ⚠️ На автопути такая очередь есть с #138, и шапка `invite-delivery.ts` называет промежуток между
 * «нашёл» и «создал» тем самым местом, где записывают дважды. Ручной путь исполняет ту же
 * последовательность, а очереди у него не было: кнопка гаснет только внутри ОДНОГО виджета, и два
 * открытых окна (или два сотрудника на одной сделке) проходили гейт оба.
 */
const manualSerial = createKeySerializer()

export interface ManualInviteInput {
  dealId: number
  surveyKey: string
  context: CrmContext
  /**
   * Осознанное «всё равно создать новую ссылку».
   *
   * ⚠️ Кнопка остаётся, и это решение: ручной путь — действие человека, который смотрит на карточку.
   * Запрещать его насовсем неправильно (прошлая ссылка могла уйти не туда, клиент мог её потерять),
   * а вот делать вид, что первой не было, — нельзя.
   */
  force?: boolean
  /**
   * Откуда пришёл обход: `dedup` — человек увидел «уже приглашали» и всё равно нажал; `reissue` —
   * прежняя ссылка мертва или непроверяема, и виджет сам предложил выписать новую.
   *
   * ⚠️ Не косметика. Без этого поля `b24_manual_activity` одинаков для первого нажатия и для
   * форсированного, то есть на вопрос «дедуп работает или его обходят всегда» ответить нечем — а это
   * ровно тот вопрос, ради которого затевался #138. Смешивать две популяции тоже нельзя: `reissue`
   * это законная перевыписка мёртвой ссылки, а не обход защиты.
   */
  forceReason?: 'dedup' | 'reissue'
}

export interface ManualInviteDeps {
  /**
   * Клиент портала ПОДТВЕРЖДЁННОГО фрейма — токеном пользователя виджета, как и `crm.deal.get`.
   *
   * ⚠️ Правами СОТРУДНИКА, а не приложения (автопуть ищет токеном портала). Дела, которых сотрудник
   * не видит, дедуп не найдёт — и это не дефект, а следствие: он и не должен читать чужую CRM. Но
   * при разборе живого прогона помнить обязательно: `found: 0` тут значит «этот сотрудник дел не
   * видит», а не «дел нет».
   */
  client: PortalClient
  /**
   * Портал (`member_id`) — только как ПРЕФИКС ключа очереди. ID сделок у порталов совпадают штатно, и
   * без префикса медленный REST одного заказчика держал бы очередь другого.
   */
  portalId: string
  store: Pick<IStore, 'currentVersion' | 'hasResponseSince'>
  invitations: InvitationStore
  /** База абсолютной ссылки (`APP_DOMAIN`/`DOMAIN`); пустая — ссылка выйдет относительной. */
  baseUrl: string
  log: {
    info: (event: string, fields: Record<string, unknown>) => void
    warn: (event: string, fields: Record<string, unknown>) => void
  }
  now?: Date
}

export type ManualInviteOutcome =
  /**
   * По этой сделке и опросу уже висит открытое дело-приглашение. Ничего не создано.
   *
   * `surveyTitle` — чтобы человека можно было отправить к КОНКРЕТНОМУ делу («Опрос: …»), а не «куда-то
   * в таймлайн». Без имени правильный путь («найди дело и нажми в нём кнопку») дороже неправильного
   * («всё равно создать новую»), и дедуп через полгода станет задержкой в один клик.
   *
   * ⚠️ **Саму ссылку мы НЕ отдаём, и это решение.** Issue просил «вот ссылка», но токен лежит в теле
   * УЖЕ СОЗДАННОГО дела, и достать его значило бы вторым REST читать чужую разметку таймлайна —
   * ставка на формат, который вживую не сверен. Вместо этого ведём к делу, где ссылка уже есть и где
   * рядом стоит рабочая кнопка «Отправить приглашение» (её путь построен в #126/#175). `activityIds`
   * наружу не идут — их читают только лог и тесты.
   */
  | { kind: 'existing'; activityIds: number[]; surveyTitle?: string }
  /**
   * Клиент по этой сделке и опросу УЖЕ ОТВЕТИЛ (дело закрыто ответом, #177).
   *
   * ⚠️ Без этой ветки дедуп был слеп ровно после ответа: `findOpenInviteActivities` фильтрует
   * `COMPLETED='N'`, а `closeInvite` закрывает дело в момент ответа — то есть следующее нажатие молча
   * выписывало новую ссылку по уже отвеченной сделке. Автопуть в этом месте спрашивает наш стор
   * (`hasResponseSince`) и отвечает `skip: answered`; документ обещал паритет, которого не было.
   * Запрещать не запрещаем — говорим и оставляем осознанное «всё равно создать».
   */
  | { kind: 'answered'; surveyTitle?: string }
  /** У опроса нет опубликованной версии — выписывать нечего. */
  | { kind: 'unpublished' }
  /** Приглашение выписано; `activityId` есть, если дело в таймлайне удалось создать. */
  | { kind: 'created'; surveyKey: string; token: string; url: string; activityId?: number }

/**
 * Ручная выписка приглашения по сделке: сначала «уже приглашали?», потом создание.
 *
 * ⚠️ **Ищем по ВЛАДЕЛЬЦУ и коду приложения, а не по маркеру.** Полный маркер собирается из ключа
 * перехода, а ручной путь перехода не подтверждает — его тут просто нет. Зато `openInviteActivities`
 * отвечает ровно на нужный вопрос: «висит ли по этой сделке НАШЕ открытое дело по ЭТОМУ опросу»,
 * причём одинаково видит и автоматические дела, и ручные.
 *
 * ⚠️ **Дело здесь — ЗАПИСЬ, а не канал доставки**, и в этом единственное отличие от автопути. Ссылку
 * менеджер получает в самом виджете, поэтому отказ создания дела НЕ гасит токен: на автопути ссылка
 * без дела недостижима никому, здесь — уже в руках человека. Гасить её значило бы отобрать сделанную
 * работу из-за неудавшейся отметки. Цена честная и записана: без дела следующее нажатие о нём не
 * узнает, поэтому отказ логируется как `warn`.
 */
export async function manualInvite(
  input: ManualInviteInput,
  deps: ManualInviteDeps
): Promise<ManualInviteOutcome> {
  // ⚠️ Весь путь «поиск → создание» под очередью, а не одно создание: промежуток между «нашёл» и
  // «создал» — ровно то место, где два открытых виджета проскакивают дважды.
  return manualSerial.run(`${deps.portalId}:manual:${input.dealId}:${input.surveyKey}`, () =>
    manualInviteInner(input, deps))
}

async function manualInviteInner(
  input: ManualInviteInput,
  deps: ManualInviteDeps
): Promise<ManualInviteOutcome> {
  const now = deps.now ?? new Date()
  const { dealId, surveyKey } = input
  // Заголовок опроса из НАШЕЙ базы: лишнего REST не стоит, а без имени человека некуда вести
  // (см. разбор у `ManualInviteOutcome`). Нет версии — обойдёмся без имени.
  const titleOf = async (): Promise<{ surveyTitle?: string }> => {
    const title = (await deps.store.currentVersion(surveyKey).catch(() => undefined))?.title
    return title ? { surveyTitle: title } : {}
  }

  if (!input.force) {
    // ⚠️ Отказ поиска — НЕ повод молча выписать вторую ссылку и не повод отказать человеку. Считаем
    // «открытых дел не нашли» и идём создавать: ручной путь начат осознанным действием, и упереть его
    // в недоступность CRM хуже, чем изредка допустить дубль, который менеджер видит своими глазами.
    const open = await findOpenInviteActivities(deps.client, dealId, surveyKey).catch((e: unknown) => {
      deps.log.warn('b24_manual_lookup_fail', { surveyKey, dealId, err: errInfo(e) })
      return { found: 0, ids: [] as number[] }
    })
    // ⚠️ Решение по `found`, а НЕ по `ids.length`: строка без читаемого id всё равно означает «дело
    // есть». Выбросив её, дедуп пригласил бы второй раз (разбор — у `findOpenInviteActivities`).
    if (open.found > 0) {
      const activityIds = open.ids.slice(0, MAX_EXISTING_IDS)
      deps.log.info('b24_manual_dedup', { surveyKey, dealId, found: open.found, activityIds })
      return { kind: 'existing', activityIds, ...(await titleOf()) }
    }
    // ⚠️ Дело закрывается ОТВЕТОМ клиента (#177), поэтому «открытых дел нет» ≠ «не приглашали».
    // Спрашиваем свой стор, как это делает автопуть: `new Date(0)` — «отвечал ли вообще», момента
    // перехода на ручном пути не существует.
    const answered = await deps.store
      .hasResponseSince(surveyKey, dealId, new Date(0))
      .catch(() => false) // отказ своей базы не должен запирать человека — тот же принцип, что выше
    if (answered) {
      deps.log.info('b24_manual_answered', { surveyKey, dealId })
      return { kind: 'answered', ...(await titleOf()) }
    }
  }

  const res = await createSurveyInvitation({
    store: deps.store, invitations: deps.invitations, surveyKey, context: input.context, now
  })
  if (!res) return { kind: 'unpublished' }
  const url = `${deps.baseUrl}${surveyPath(res.surveyKey, res.token)}`

  // ⚠️ Маркер СВОЙ (`manual:<секунды>:<опрос>`), а не `stage:` с выдуманным переходом: подделав ключ
  // перехода, ручное дело начало бы съедать приглашение по настоящему переходу как дубль. Разбор —
  // в `invite-delivery.ts`. Округление до секунды делает сам `manualInviteMarker`.
  const marker = manualInviteMarker(now.getTime() / 1000, res.surveyKey)
  try {
    const activityId = await activityConfigurableAdd(deps.client, buildSurveyInviteActivity({
      dealId,
      surveyTitle: res.title,
      surveyKey: res.surveyKey,
      token: res.token,
      surveyUrl: url,
      ...(input.context.responsibleId != null ? { responsibleId: input.context.responsibleId } : {}),
      marker
    }))
    // Та же сверка маркера, что и на автопути: принимает ли `configurable.add` поля маркера, вживую
    // не проверено, а без маркера дело не найдётся ни следующим нажатием, ни закрытием по ответу.
    const markerFix = await ensureActivityMarker(deps.client, activityId, marker).catch(() => 'failed' as const)
    deps.log[markerFix === 'failed' ? 'warn' : 'info']('b24_manual_activity', {
      surveyKey: res.surveyKey,
      dealId,
      activityId,
      markerFix,
      // ⚠️ Обход дедупа обязан быть ИЗМЕРИМ, иначе живой прогон (#126) не отличит «дедуп сработал»
      // от «дедуп обошли». `forced` без причины смешал бы законную перевыписку мёртвой ссылки с
      // настоящим обходом — поэтому рядом едет `forceReason`.
      forced: input.force === true,
      ...(input.forceReason ? { forceReason: input.forceReason } : {})
    })
    return { kind: 'created', surveyKey: res.surveyKey, token: res.token, url, activityId }
  } catch (e) {
    // ⚠️ Токен НЕ гасим — см. разбор в JSDoc. Ссылка уже уходит человеку ответом виджета.
    deps.log.warn('b24_manual_activity_fail', { surveyKey: res.surveyKey, dealId, err: errInfo(e) })
    return { kind: 'created', surveyKey: res.surveyKey, token: res.token, url }
  }
}
