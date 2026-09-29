import type { RestCall } from './provision'
import { safeRefusal } from '../domain/answers/portal-errors'
import { buildActivityBlocksCall, readBlocksApplied, type LayoutBlocks } from '../domain/answers/activity-blocks'
import {
  activityDeadline,
  activityOriginId,
  bindingKey,
  buildActivityMarkerCall,
  buildBindActivityCall,
  buildFindActivityCall,
  buildIssueActivityDescription,
  buildIssueActivityTitle,
  buildListBindingsCall,
  buildOverwriteActivityCall,
  buildRevokedActivityCall,
  buildTodoActivityCall,
  isUntouchedIssueActivity,
  linkActivityOriginId,
  ownerOf,
  readBindingKeys,
  readActivityId,
  readBindApplied,
  readFoundActivity,
  readFoundActivityId,
  readMarkApplied,
  RESULT_TITLE_PREFIX,
  type ActivityOwner,
  type FoundActivity,
} from '../domain/answers/timeline-activity'
import { DEAL_ENTITY_TYPE_ID } from '../domain/portals/smart-processes'
import type { SmartProcessRef } from '../domain/portals/smart-processes'
import { DEAL_TAB_TITLE } from '../../shared/portal-names'
import { logger } from '../utils/logger'

/**
 * The survey's activity in the deal timeline, through its whole life (#84, п. 14 и 6).
 *
 * Одно дело на одну ссылку:
 *
 * 1. **Выпуск** — «Отправить опрос клиенту: <анкета>», в описании адрес анкеты и срок. Ключ
 *    выпуска (`linkActivityOriginId`). К элементу «Результата опросов» НЕ привязывается — почему,
 *    у `tryIssueActivity`.
 * 2. **Ответ** — то же дело перезаписывается итогом: заголовок с баллом, описание со словами
 *    клиента, блоки с баллами. Ключ меняется на ключ итога (`activityOriginId`), и только теперь
 *    дело привязывается к элементу. Закрытое менеджером дело портал перезаписать не даёт — тогда
 *    итог пишется новым делом рядом, как до п. 14.
 * 3. **Отзыв** — открытое дело выпуска закрывается с пометкой «Ссылка отозвана», адрес из него уходит.
 *
 * ⚠ ВСЁ ЗДЕСЬ — ЛУЧШИЕ УСИЛИЯ. Ссылка работает и без дела выпуска, ответ живёт в элементе
 * и без дела итога, отзыв гасит ссылку и без закрытого дела. Отказ любого шага — строка
 * в журнал, а не отказ выпуска, доставки или отзыва.
 *
 * ⚠ Файл общий для выпуска (`server/links/issue-flow.ts`), доставки (`server/answers/deliver.ts`)
 * и отзыва (`server/api/portal/revoke.post.ts`) — и для живой проверки `pnpm verify:link`,
 * которая ходит теми же функциями. Помощники метки и привязки переехали сюда из `deliver.ts`,
 * когда делом занялись три места вместо одного.
 */

/**
 * Завести дело выпуска: «Отправить опрос клиенту», адрес анкеты и срок.
 *
 * ⚠ ПОИСКА ПЕРЕД СОЗДАНИЕМ НЕТ, и инвариант «перед созданием — поиск существующего» этим
 * не нарушен. Ключ дела — номер элемента, созданного этим же выпуском мгновением раньше:
 * дела с таким ключом быть не может. Повтора у выпуска тоже нет — это запрос человека,
 * а не задача очереди, и новый выпуск заводит новый элемент.
 *
 * ⚠ Зовётся ПОСЛЕ того, как индекс ссылок узнал токен (`issueLink`, шаг 5). Адрес в деле
 * раньше этого остался бы в ленте сделки рабочей на вид ссылкой на «не найдено» — та же
 * причина, по которой адрес в элемент уходит последним.
 *
 * ⚠ К ЭЛЕМЕНТУ «РЕЗУЛЬТАТА ОПРОСОВ» НЕ ПРИВЯЗЫВАЕМ, хотя п. 14 предлагал, и это замер, а не
 * забывчивость. Финальная стадия элемента закрывает ВСЕ открытые дела, привязанные к нему, —
 * владельцем или просто привязкой (замерено 29.09 на тестовом портале; в документации этого нет).
 * А доставка ставит «Пройдена», а отзыв — «Отозвана» РАНЬШЕ, чем трогают дело: привязанное дело
 * выпуска закрывалось бы порталом за мгновение до перезаписи итогом или пометки «Ссылка отозвана»,
 * и итог уходил бы новым делом рядом. Первый живой прогон `verify:link` так и упал. Дело итога
 * привязывается к элементу при записи итога — когда стадия уже финальная и закрывать его нечему.
 */
export async function tryIssueActivity(
  call: RestCall,
  input: {
    survey: SmartProcessRef
    itemId: number
    dealId: number
    surveyTitle: string
    url: string
    expiresAt: Date
    /** Кто выпустил. Ноль — портал поставит владельца токена. */
    responsibleId: number
  },
): Promise<void> {
  try {
    const add = buildTodoActivityCall({
      dealEntityTypeId: DEAL_ENTITY_TYPE_ID,
      dealId: input.dealId,
      title: buildIssueActivityTitle(input.surveyTitle),
      description: buildIssueActivityDescription(input.url, input.expiresAt),
      // ⚠ Срок дела — срок ССЫЛКИ, а не сутки. Сутки делали дело просроченным со второго дня
      // до самого ответа — при ссылке на тридцать дней — и подталкивали закрыть его, после чего
      // итог уходил новым делом рядом. Теперь просрочка значит ровно одно: ссылка истекла,
      // а ответа нет. И портал показывает этот срок в поясе человека (`/review`, PR #102).
      deadline: input.expiresAt,
      ...(input.responsibleId > 0 ? { responsibleId: input.responsibleId } : {}),
    })
    const activityId = readActivityId(await call(add.method, add.params))
    if (activityId === null) {
      logger.warn({}, 'дело выпуска не записано: портал не вернул идентификатор; ссылка работает')
      return
    }

    if (!(await markActivity(call, activityId, linkActivityOriginId(input.survey.entityTypeId, input.itemId)))) {
      // Дело в ленте есть, но доставка его не найдёт: итог придёт новым делом рядом,
      // а это останется с адресом. Видно и чинится закрытием руками.
      logger.error({}, 'дело выпуска записано БЕЗ ключа: итог придёт новым делом рядом')
    }

    logger.info({}, 'дело выпуска записано в ленту сделки')
  }
  catch (error) {
    // ⚠ Наружу — наш код отказа, не текст портала: в вызове лежит адрес анкеты с токеном,
    // а Битрикс24 любит цитировать присланное в тексте ошибки.
    logger.warn({ reason: safeRefusal(error) }, 'дело выпуска не записано; ссылка работает')
  }
}

/** Everything the result activity needs, built by the delivery from the answer. */
export interface ResultActivityPlan {
  dealId: number
  itemId: number
  survey: SmartProcessRef
  title: string
  description: string
  color: string
  responsibleId: number
  blocks: LayoutBlocks
}

/**
 * Положить итог в ленту сделки: перезаписать дело выпуска или создать новое.
 *
 * ⚠ Порядок поиска — сначала ключ ИТОГА, потом ключ ВЫПУСКА. Найден итог — он уже записан
 * (повтор доставки), второго не пишем. Иначе смотрим дело выпуска: открытое и нетронутое
 * перезаписываем. Закрытое не трогаем — портал его не даст; правленное человеком не трогаем —
 * перезапись стёрла бы его заметку. В обоих случаях итог пишется новым делом рядом. Нет ни того,
 * ни другого — ссылка выпущена до п. 14 или дело выпуска не записалось, — новое дело, как прежде.
 *
 * ⚠ Закрытым дело выпуска бывает не только руками: финальная стадия СДЕЛКИ («Сделка успешна»)
 * закрывает её открытые дела — замерено 29.09, как и у элемента. Опрос по закрытию проекта
 * поэтому обычно приходит новым делом рядом.
 *
 * Возвращает, стоит ли итог в ленте: перезаписан, создан или уже был.
 */
export async function writeResultActivity(call: RestCall, plan: ResultActivityPlan): Promise<boolean> {
  // ⚠ Инвариант проекта: перед созданием — поиск существующего. Источник правды о том,
  // писали мы уже или нет, — сам портал, а не таблица у нас.
  const written = await findActivity(call, activityOriginId(plan.survey.entityTypeId, plan.itemId))
  if (written !== null) {
    logger.info({}, 'итог уже записан делом, второго не создаём')
    // ⚠ Блоки и привязку досылаем И ЗДЕСЬ: сюда приходит повтор доставки, а прошлая попытка могла
    // оборваться между меткой и блоками. Второй раз дело не пишется, и без досылки итог навсегда
    // остался бы без баллов разделов и без второй ленты. Оба вызова безопасно повторять: набор
    // блоков заменяется целиком, стоящая привязка читается до постановки (`/review`, PR #102).
    await trySetBlocks(call, written.id, ownerOf(written, plan.dealId), plan.blocks)
    await tryBindToSurveyItem(call, written.id, plan.survey, plan.itemId)
    return true
  }

  const issued = await findActivity(call, linkActivityOriginId(plan.survey.entityTypeId, plan.itemId))
  if (issued !== null && !issued.completed && isUntouchedIssueActivity(issued) && await overwriteWithResult(call, issued, plan)) return true
  if (issued !== null && issued.completed) {
    logger.info({}, 'дело выпуска закрыто — итог пишем новым делом рядом')
  }
  else if (issued !== null && !isUntouchedIssueActivity(issued)) {
    logger.info({}, 'дело выпуска правил человек — не перезаписываем, итог пишем новым делом рядом')
  }

  return await createResultActivity(call, plan)
}

/**
 * Перезаписать открытое дело выпуска итогом.
 *
 * ⚠ ТРИ ВЫЗОВА, И ПОРЯДОК НЕСУЩИЙ. Сначала содержимое (`todo.update`), потом ключ итога, потом
 * блоки. Ключ итога после содержимого: упади мы между ними, повтор доставки найдёт дело по ключу
 * выпуска и перезапишет его ещё раз — перезапись идемпотентна. Обратный порядок оставил бы дело
 * с ключом итога и адресом анкеты вместо итога, и повтор счёл бы итог записанным.
 *
 * ⚠ Чего это не закрывает: дело перезаписано, ключ не лёг, и между этим и повтором доставки
 * менеджер закрыл дело. Повтор увидит закрытое дело выпуска и напишет итог второй раз, рядом.
 * Нужны два редких события подряд; цена — дубль итога в ленте, а не потеря.
 *
 * Возвращает `false`, когда перезапись не прошла: итог тогда пишется новым делом.
 */
async function overwriteWithResult(call: RestCall, found: FoundActivity, plan: ResultActivityPlan): Promise<boolean> {
  const owner = ownerOf(found, plan.dealId)
  const update = buildOverwriteActivityCall(found.id, owner, {
    title: plan.title,
    description: plan.description,
    deadline: activityDeadline(new Date()),
    color: plan.color,
    responsibleId: plan.responsibleId,
  })
  try {
    if (readActivityId(await call(update.method, update.params)) === null && !(await overwriteLanded(call, plan))) {
      logger.warn({}, 'дело выпуска не перезаписано: портал не подтвердил перезапись — итог пойдёт новым делом')
      return false
    }
  }
  catch (error) {
    // ⚠ Закрытое дело отсюда почти не приходит — оно отсеяно по `COMPLETED` до вызова. Сюда попадает
    // гонка «закрыли, пока мы читали», отказ портала — и наш таймаут или обрыв связи, когда портал
    // запрос уже применил. Последнее различимо только переспросом (`overwriteLanded`); без него
    // одна перезапись без ответа давала бы второе дело итога рядом (`/code-review`, PR #102).
    if (!(await overwriteLanded(call, plan))) {
      logger.warn({ reason: safeRefusal(error) }, 'дело выпуска не перезаписано: портал отказал — итог пойдёт новым делом')
      return false
    }
  }

  if (!(await markActivity(call, found.id, activityOriginId(plan.survey.entityTypeId, plan.itemId)))) {
    // Итог в ленте есть; не найдёт его только повтор доставки, а он после удачной доставки не наступает.
    logger.error({}, 'дело перезаписано итогом, но ключ итога не лёг: как итог его не найти')
  }
  await trySetBlocks(call, found.id, owner, plan.blocks)
  await tryBindToSurveyItem(call, found.id, plan.survey, plan.itemId)
  logger.info({}, 'дело выпуска перезаписано итогом опроса')
  return true
}

/**
 * Легла ли перезапись, на которую портал не ответил как надо.
 *
 * ⚠ ТОТ ЖЕ ПРИЁМ, ЧТО У МЕТКИ (`markActivity`): исключение означает «мы не дождались ответа», а не
 * «портал ничего не сделал». Дело выпуска перезаписано, если оно по-прежнему открыто и его заголовок
 * начинается как заголовок итога — у дела выпуска свой, другой. Сверяем начало, а не заголовок
 * целиком: портал, который по-своему хранит эмодзи или пробелы, давал бы ложное «нет» и дубль итога
 * (`/review`, PR #102). Не смогли даже спросить — «нет»: худшее тогда — дубль итога рядом, а не потеря.
 */
async function overwriteLanded(call: RestCall, plan: ResultActivityPlan): Promise<boolean> {
  try {
    const again = await findActivity(call, linkActivityOriginId(plan.survey.entityTypeId, plan.itemId))
    return again !== null && !again.completed && again.subject.startsWith(RESULT_TITLE_PREFIX)
  }
  catch {
    return false
  }
}

/**
 * Создать дело итога и сделать его находимым.
 *
 * ⚠ Два вызова, и это навязано, а не выбрано: `crm.activity.todo.add` метку не принимает,
 * `DESCRIPTION_TYPE` — тоже. Между ними есть окно, в котором дело существует БЕЗ метки:
 * остановись мы там, поиск его больше никогда не нашёл бы, а следующая запись создала бы
 * второе.
 *
 * ⚠ Чего это окно не закрывает: жёсткая смерть процесса между созданием и пометкой.
 * Останется одно ненаходимое дело. Закрыть это с нашей стороны нечем — нужен был бы
 * атомарный «создать с меткой», которого у этого типа дел нет. Цена ограничена одним делом
 * на падение, а не на ответ.
 */
async function createResultActivity(call: RestCall, plan: ResultActivityPlan): Promise<boolean> {
  const add = buildTodoActivityCall({
    dealEntityTypeId: DEAL_ENTITY_TYPE_ID,
    dealId: plan.dealId,
    title: plan.title,
    description: plan.description,
    deadline: activityDeadline(new Date()),
    color: plan.color,
    ...(plan.responsibleId > 0 ? { responsibleId: plan.responsibleId } : {}),
  })
  const activityId = readActivityId(await call(add.method, add.params))
  if (activityId === null) {
    logger.warn({}, 'итог не записан: портал не вернул идентификатор дела')
    return false
  }

  if (await markActivity(call, activityId, activityOriginId(plan.survey.entityTypeId, plan.itemId))) {
    logger.info({}, 'итог опроса записан делом в таймлайн сделки')
  }
  else {
    // ⚠ ДЕЛО ОСТАЁТСЯ, И ЭТО СМЕНА РЕШЕНИЯ. Раньше здесь стояла компенсация: непомеченное
    // дело снималось, чтобы следующая доставка не создала второе. Замер на живом портале
    // 24.09 показал, что компенсация своей цели НЕ достигает — `crm.activity.delete` убирает
    // дело, а его запись в ленте сделки остаётся навсегда, с тем же заголовком и тем же
    // полным текстом. Снять её нечем: у метода удаления других параметров нет,
    // а `crm.timeline.logmessage.delete` работает только со своими записями.
    //
    // То есть удаление меняло «дело, которое может задвоиться» на «мёртвый текст в ленте»
    // и при повторной доставке давало ровно ту картину, из-за которой заведён issue #45:
    // сверху живое дело, ниже запись с тем же текстом. Живое дело без метки честнее:
    // менеджер видит итог и кнопки, а цена — возможный дубль, и только если ЭТОТ ЖЕ ответ
    // доставят ещё раз.
    logger.error({}, 'дело записано БЕЗ метки: поиск его не найдёт, повторная доставка создаст второе')
  }

  // Блоки — владельцем-сделкой: до привязки владелец дела она, и к ней дело привязано всегда.
  await trySetBlocks(call, activityId, { entityTypeId: DEAL_ENTITY_TYPE_ID, entityId: plan.dealId }, plan.blocks)

  // ⚠ Привязка ставится ПОСЛЕ пометки и НЕ входит в её исход. Дело создано и находимо —
  // это главное; привязка только добавляет его во вторую ленту.
  await tryBindToSurveyItem(call, activityId, plan.survey, plan.itemId)
  return true
}

/**
 * Закрыть дело выпуска при отзыве ссылки: «Ссылка отозвана», адрес из текста уходит.
 *
 * Открытое — закрываем. Закрытое менеджером не трогаем: он его уже закрыл, а старый адрес
 * в нём отозван и не открывается. Дела нет — ссылка выпущена до п. 14, закрывать нечего.
 */
export async function tryRevokeActivity(call: RestCall, survey: SmartProcessRef, itemId: number): Promise<void> {
  try {
    const found = await findActivity(call, linkActivityOriginId(survey.entityTypeId, itemId))
    if (found === null || found.completed) return

    const close = buildRevokedActivityCall(found, DEAL_TAB_TITLE)
    if (readMarkApplied(await call(close.method, close.params))) {
      logger.info({}, 'дело выпуска закрыто: ссылка отозвана')
    }
    else {
      logger.warn({}, 'дело выпуска не закрыто: портал ответил «нет»; ссылка отозвана')
    }
  }
  catch (error) {
    logger.warn({ reason: safeRefusal(error) }, 'дело выпуска не закрыто; ссылка отозвана')
  }
}

/** Find our activity by its marker. */
async function findActivity(call: RestCall, originId: string): Promise<FoundActivity | null> {
  const find = buildFindActivityCall(originId)
  return readFoundActivity(await call(find.method, find.params))
}

/**
 * Повесить на дело блоки итога.
 *
 * ⚠ ЛУЧШИЕ УСИЛИЯ И НИКОГДА НЕ БРОСАЕТ. Вызов идёт после записи дела: итог уже в ленте,
 * а в блоках нет ничего, чего нет в заголовке дела и в карточке «Результата опросов».
 * Отказ делает дело беднее и не теряет сведений.
 *
 * ⚠ Вебхуком метод не работает вовсе (`ERROR_WRONG_CONTEXT`) — это путь `verify:link`, и там
 * строка журнала ожидаема.
 */
async function trySetBlocks(call: RestCall, activityId: string, owner: ActivityOwner, blocks: LayoutBlocks): Promise<void> {
  try {
    const set = buildActivityBlocksCall(activityId, owner, blocks)
    if (!readBlocksApplied(await call(set.method, set.params))) {
      logger.warn({}, 'блоки итога не встали: портал не подтвердил')
    }
  }
  catch (error) {
    logger.warn({ reason: safeRefusal(error) }, 'блоки итога не встали; итог в заголовке, разбор — в карточке «Опроса»')
  }
}

/**
 * Привязать дело ещё и к элементу «Опроса».
 *
 * ⚠ ЛУЧШИЕ УСИЛИЯ, а не обязательство. Отказ привязки не должен ни ронять запись,
 * ни запускать компенсирующее удаление. Отказ — в журнал, и всё. Форма взята у соседа
 * (`activityBindingsWrite.ts`), где оплачена живым порталом.
 *
 * ⚠ СНАЧАЛА ЧИТАЕМ, ПОТОМ СТАВИМ. Повторная привязка той же пары — ошибка
 * (`ACTIVITY_IS_ALREADY_BOUND`), а через SDK до нас доезжает локализованный ТЕКСТ без кода,
 * то есть отличить её от настоящего отказа нечем. Один лишний вызов дешевле разбора чужой
 * строки, которая завтра придёт на другом языке.
 *
 * ⚠ Что это НЕ доказывает: привязка к несуществующей сущности отвечает `{result: true}` —
 * портал молча принимает `entityId`, которого нет (замер соседа). Значит «вызов не упал»
 * не значит ничего, и единственная защита — правильность самих ссылок.
 */
async function tryBindToSurveyItem(
  call: RestCall,
  activityId: string,
  survey: SmartProcessRef,
  itemId: number,
): Promise<void> {
  try {
    const list = buildListBindingsCall(activityId)
    const already = readBindingKeys(await call(list.method, list.params))
    if (already.has(bindingKey(survey.entityTypeId, itemId))) return

    const bind = buildBindActivityCall(activityId, survey.entityTypeId, itemId)
    if (readBindApplied(await call(bind.method, bind.params))) {
      logger.info({}, 'дело привязано к элементу «Опроса»')
    }
    else {
      logger.warn({}, 'дело не привязано к элементу «Опроса»: портал ответил «нет»; в сделке оно есть')
    }
  }
  catch (error) {
    // Дело в ленте сделки на месте — потеряна только вторая лента.
    logger.warn({ reason: safeRefusal(error) }, 'дело не привязано к элементу «Опроса»; в сделке оно есть')
  }
}

/**
 * Нанести метку, со второй попыткой.
 *
 * ⚠ ДВЕ ПОПЫТКИ, А НЕ ОДНА, и вторая стоит ровно одного вызова на пути отказа. Метка —
 * единственное, что делает дело находимым, а `crm.activity.update` идемпотентен: те же поля,
 * тот же результат. Раз цена ошибки — дубль в ленте клиента, один дешёвый повтор окупается.
 *
 * ⚠ СНАЧАЛА ПЕРЕСПРАШИВАЕМ ПОРТАЛ, и только потом повторяем. Исключение из пометки означает
 * «мы не дождались ответа», а не «портал ничего не сделал»: наш собственный таймаут и обрыв
 * сети выглядят точно так же, при том что запрос мог дойти и примениться. Без переспроса
 * второй вызов шёл бы вслепую.
 *
 * ⚠ Двухсотый ответ с `false` — задокументированный путь отказа этого метода. Приняв его
 * за успех, мы оставили бы дело без метки и не узнали бы об этом. Нашла панель ревью.
 *
 * ⚠ Той же функцией дело выпуска получает ключ ИТОГА при перезаписи: `ORIGIN_ID` меняется
 * вызовом `crm.activity.update` так же, как ставится впервые (замерено 29.09 — по старому ключу
 * дело больше не находится, по новому находится).
 */
async function markActivity(call: RestCall, activityId: string, originId: string): Promise<boolean> {
  const mark = buildActivityMarkerCall(activityId, originId)

  for (const attempt of [1, 2]) {
    try {
      if (readMarkApplied(await call(mark.method, mark.params))) return true
    }
    catch (error) {
      logger.warn({ attempt, reason: safeRefusal(error) }, 'пометка дела не прошла')

      // Портал мог применить её и не успеть ответить — тогда повторять нечего.
      if (await isActivityFindable(call, originId)) return true
    }
  }

  return false
}

/** Находится ли дело по метке. Единственный вопрос, ответ на который здесь и нужен. */
async function isActivityFindable(call: RestCall, originId: string): Promise<boolean> {
  try {
    const find = buildFindActivityCall(originId)
    return readFoundActivityId(await call(find.method, find.params)) !== null
  }
  catch {
    // Не смогли даже спросить — отвечаем «нет»: повтор пометки безвреден, а ложное «да»
    // оставило бы дело ненаходимым молча.
    return false
  }
}
