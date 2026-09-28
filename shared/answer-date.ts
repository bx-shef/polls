/**
 * The answer to a date question: what counts as a date, and how it reads in Russian.
 *
 * Одно определение на четыре места — виджет публичной страницы (`app/components/survey/DateInput.vue`),
 * проверку присланного (`server/domain/surveys/answer.ts`), виджет в карточке «Результата опросов»
 * (`server/domain/surveys/result-view.ts`) и дело в ленте сделки (`server/domain/answers/comment.ts`).
 * Расходиться им нельзя: дата, которую отправил виджет, обязана пройти проверку, а принятая
 * проверкой — показываться датой и в карточке, и в ленте. Поэтому модуль в `shared/`, а не
 * на сервере: прежде виджет собирал запись провода своей копией и не мог проверить, что шлёт, —
 * так и уехал год из двух цифр (панель ревью PR #91).
 *
 * По проводу дата едет строкой `ГГГГ-ММ-ДД` — ISO 8601, день без времени и без пояса. Её шлёт
 * календарь публичной страницы, её же ждёт проверка, а в русскую запись `ДД.ММ.ГГГГ` она
 * превращается только на показе. Почему так, а не русской записью с самого начала, — в
 * `docs/PROCESS.md`, раздел 6, «Что решилось, когда публичная страница написалась».
 *
 * ⚠ Без `Date` — только арифметика календаря. В Node `new Date('2026-02-30')` — это 2 марта
 * без всякой ошибки, а `Date.parse('09/28/2026')` охотно читает американскую запись: проверка
 * через них приняла бы датой то, чего календарь страницы не пришлёт никогда. К тому же дата
 * ответа — это день, а не момент: у респондента в Минске и у сервера в UTC это один и тот же
 * день, и гонять его через пояс незачем.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Earliest and latest year a date answer may carry.
 *
 * ⚠ ОКНО, А НЕ «ЛЮБОЙ ГОД ОТ ПЕРВОГО». Поле даты набора собирает дату после каждой цифры года:
 * набранное по привычке «28.09.26» уезжало как `0026-09-28`, а год «2026», набранный наполовину, —
 * как `0202-09-28`. Формально это настоящие дни календаря, и проверка их принимала; ссылка при этом
 * одноразовая, и в карточке навсегда оставалось «28.09.0026». Нашли `/review` и `/code-review`
 * в PR #91. Окно широкое: дата рождения клиента, дата сделки, срок проекта в него попадают,
 * а недонабранный год — нет. Сдвинуть его — решение владельца, и меняется оно здесь, одной строкой.
 */
export const ANSWER_YEARS = { min: 1900, max: 2100 } as const

/** Whether the text is a real calendar day `YYYY-MM-DD` within `ANSWER_YEARS`: `2026-02-30` is not, nor is `28.09.2026`. */
export function isCalendarDate(text: string): boolean {
  const match = ISO_DATE.exec(text)
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  return year >= ANSWER_YEARS.min && year <= ANSWER_YEARS.max
    && month >= 1 && month <= 12
    && day >= 1 && day <= daysInMonth(year, month)
}

/**
 * The wire form of a day: `YYYY-MM-DD`, built from the date's fields.
 *
 * ⚠ Из ПОЛЕЙ даты явно, а не `toString()` объекта виджета: формат провода — наш договор
 * с сервером, а не формат чужой библиотеки, у которой значение со временем печатается с хвостом
 * `T00:00:00`, и проверка его справедливо отвергла бы.
 */
export function isoDay(date: { year: number, month: number, day: number }): string {
  const pad = (value: number, width: number) => String(value).padStart(width, '0')
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`
}

/**
 * A date answer in Russian: `2026-09-28` → `28.09.2026`; anything else comes back as it was.
 *
 * ⚠ Не дату возвращает КАК ПРИШЛА. До календаря на публичной странице вопрос «Дата» рисовался
 * текстовым полем и принимал что угодно («в пятницу», «28.09»), и такие ответы могли уже уехать
 * в портал. Выбросить их нельзя — это ответ клиента, — а выдать за дату нельзя тем более.
 * Обезвреживает разметку в них тот, кто показывает, — как и у любого другого ответа.
 */
export function formatAnswerDate(text: string): string {
  const trimmed = text.trim()
  if (!isCalendarDate(trimmed)) return text
  return `${trimmed.slice(8, 10)}.${trimmed.slice(5, 7)}.${trimmed.slice(0, 4)}`
}

/** Days in the month. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

/** Whether the year is a leap year by the Gregorian rule: 2000 is, 1900 is not. */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}
