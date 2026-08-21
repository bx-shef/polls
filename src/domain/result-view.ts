import type { CompiledVersion, CrmContext, ResponseRecord } from './schema'
import { summarizeResponse, type ResultLine } from './result-summary'

/**
 * Вид ОДНОГО ответа для страницы просмотра результата (#18) — чистая доменная сборка, без CRM и без
 * фреймворка.
 *
 * **Зачем отдельно от `summarizeResponse`.** Та же пара «вопрос → значение», но у сводки в таймлайне
 * и у страницы разные пределы, и путать их нельзя. Дело в карточке — это карточка: Bitrix24 берёт
 * 1..20 блоков, длинный текст в ней всё равно не прочитать, поэтому сводка режется (15 строк, 300
 * символов). Страница открывается ровно затем, чтобы прочитать ответ ЦЕЛИКОМ — обрезать её значит
 * оставить менеджера без того, за чем он пришёл, и при этом ничего не выиграть.
 */
export interface ResultView {
  /** Заголовок ТОЙ версии, по которой отвечал клиент, — не текущей. */
  surveyTitle: string
  surveyKey: string
  versionNo: number
  /** ISO-момент отправки; форматирует показ, а не домен. */
  submittedAt: string
  /** Отвеченные вопросы в порядке версии (не больше {@link RESULT_VIEW_MAX_LINES}). */
  lines: ResultLine[]
  /**
   * Сколько вопросов версии клиент ПРОПУСТИЛ — иначе «коротко» читается как «данные потерялись».
   *
   * ⚠️ Считается от числа ОТВЕЧЕННЫХ вопросов, а не от длины `lines`. Разница появляется, когда
   * ответов больше капа: посчитай мы `questions.length - lines.length`, обрезанные ОТВЕТЫ попали бы
   * в «пропущенные», и экран прямо соврал бы о клиенте. Сегодня кап (200) совпадает с потолком
   * вопросов в черновике, но связь эта нигде не выражена — а `compiledVersionSchema.questions`
   * максимума не имеет вовсе.
   */
  skipped: number
  /**
   * Сколько отвеченных вопросов не поместилось в кап. `0` — всё показано.
   *
   * ⚠️ Отдельным числом, а не растворённым в `skipped`: «мы не показали» и «клиент не ответил» —
   * разные вещи, и молчать о первом нельзя.
   */
  truncated: number
  /** Срез карточки: то, что позволяет менеджеру понять, о какой сделке речь. */
  context: ResultContext
}

/**
 * Срез контекста для показа.
 *
 * ⚠️ Поля перечислены ПОИМЁННО, а не «весь `context`». Снимок несёт больше, чем нужно странице
 * (стадия, категория, сумма, состав товаров), и «отдадим всё, вдруг пригодится» — это способ, которым
 * лишние данные уезжают наружу молча: сегодня в снимке появится новое поле, и оно окажется на экране
 * без единого решения. Здесь же добавление поля требует правки, то есть решения.
 *
 * ⚠️ `responsibleName` НЕ выводим: страницу открывает сотрудник в своём портале, ФИО ответственного
 * ему и так видно в карточке сделки, а дублировать ПДн туда, где они не нужны, незачем
 * ([#31](https://github.com/bx-shef/polls/issues/31) — редакция ПДн на слое чтения).
 */
export interface ResultContext {
  dealId?: number
  companyId?: number
  companyName?: string
}

/** Сколько строк показываем на странице. Кап — бэкстоп от раздувания payload, не «сводка». */
export const RESULT_VIEW_MAX_LINES = 200
/**
 * Кап значения одного ответа — бэкстоп, а не «сводка».
 *
 * ⚠️ Для обычного свободного текста он не срабатывает никогда: вход капнут теми же 2000
 * (`rawAnswerSchema.text`), и колонка в БД тоже. Реально он держит склейку мультивыбора — сто
 * выбранных опций с длинными метками, — то есть случай, когда значение растёт не от человека.
 */
export const RESULT_VIEW_MAX_VALUE = 2000

function slice(ctx: CrmContext): ResultContext {
  return {
    ...(ctx.dealId !== undefined ? { dealId: ctx.dealId } : {}),
    ...(ctx.companyId !== undefined ? { companyId: ctx.companyId } : {}),
    ...(ctx.companyName !== undefined ? { companyName: ctx.companyName } : {})
  }
}

/**
 * Собрать вид результата: версия задаёт тексты вопросов и порядок, запись — ответы и контекст.
 *
 * ⚠️ Версия обязана быть ТОЙ, по которой собран ответ (`response.versionNo`): опрос могли переиздать
 * между выпиской ссылки и ответом, и страница обязана показывать формулировки, которые человек
 * реально видел. Проверяем это здесь, а не надеемся на вызывающего: перепутанная версия дала бы
 * правдоподобный, но неверный экран — вопросы новой редакции против ответов старой.
 */
export function buildResultView(version: CompiledVersion, response: ResponseRecord): ResultView | undefined {
  if (version.surveyKey !== response.surveyKey || version.versionNo !== response.versionNo) return undefined
  // ⚠️ Сводим БЕЗ капа строк, кап применяем сами. Иначе «сколько клиент пропустил» и «сколько мы не
  // показали» слились бы в одно число: `summarizeResponse` при достижении предела обрывает цикл, и
  // отвеченные вопросы за границей стали бы неотличимы от неотвеченных.
  const answered = summarizeResponse(version, response, {
    maxLines: version.questions.length,
    maxValueLen: RESULT_VIEW_MAX_VALUE
  })
  const lines = answered.slice(0, RESULT_VIEW_MAX_LINES)
  return {
    surveyTitle: version.title,
    surveyKey: response.surveyKey,
    versionNo: response.versionNo,
    submittedAt: response.submittedAt,
    lines,
    // ⚠️ Считаем от ВОПРОСОВ ВЕРСИИ, а не от длины `answers`: пустой ответ (клиент открыл вопрос и
    // ничего не выбрал) в записи есть, но строкой не становится — иначе число разошлось бы с экраном.
    skipped: Math.max(0, version.questions.length - answered.length),
    truncated: answered.length - lines.length,
    context: slice(response.context)
  }
}
