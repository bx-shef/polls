/**
 * Shared pieces of the operator scripts: the webhook transport and the "stop with a diagnosis"
 * error. Оба переноса ходят в портал одинаково, и это общее — не совпадение.
 *
 * ⚠ Заведён после `/code-review` PR #50: `hookCall`, `Stop` и `die` лежали в двух скриптах
 * символ в символ, вместе с одним и тем же пропуском — проверкой `response.ok`. Любая правка
 * (таймаут, уважение к `Retry-After`, разбор 502) делалась бы дважды и была бы сделана один раз.
 *
 * Имя с дефисом впереди — соглашение проекта: файл рядом с обработчиками, но сам не команда.
 */
import { PortalError, refusalCodeIn, REJECTED_CODE, UNREACHABLE_CODE } from '../server/domain/portals/portal-error'
import { safeRefusal } from '../server/domain/answers/portal-errors'
import type { RestBatch, RestCall } from '../server/b24/provision'
import type { PortalCall } from '../server/domain/portals/smart-processes'

/**
 * Остановка с понятным сообщением.
 *
 * ⚠ Бросаем помеченную ошибку, а не голую: вызывающий ловит её молча, без стека. Стек здесь —
 * шум ровно в тот момент, когда оператору нужен диагноз, а не разработчику место в коде.
 */
export class Stop extends Error {
  readonly code: number
  constructor(message: string, code: number) {
    super(message)
    this.code = code
  }
}

export function die(message: string, code = 2): never {
  throw new Stop(message, code)
}

/**
 * Вызов портала входящим вебхуком.
 *
 * ⚠ ХОДИМ ВЕБХУКОМ, А НЕ ТОКЕНАМИ ПРИЛОЖЕНИЯ ИЗ БАЗЫ. Разовая операция над одним порталом
 * не должна требовать боевого `DATABASE_URL` и ключа шифрования токенов ВСЕХ клиентов
 * на машине оператора. Заодно снимается вопрос «а туда ли я пишу»: адрес вебхука содержит
 * домен портала и виден в команде.
 *
 * ⚠ Статус ответа проверяется ДО разбора JSON. Без этого HTML-страница от прокси на 502
 * роняла разбор голым `SyntaxError: Unexpected token '<'` — сообщением, по которому оператор
 * ничего не поймёт, при том что все остальные исходы оформлены человеческими фразами.
 *
 * ⚠ Ошибка портала поднимается `PortalError` С КОДОМ ОТДЕЛЬНЫМ ПОЛЕМ, а не прозой в тексте.
 * Первая редакция бросала голый `Error` с текстом портала, а комментарий рядом обещал, что
 * «наверху её пропустит через `safeRefusal`». Обещание было неправдой: `refusalCode` читает
 * только `PortalError.code`, так что у голой ошибки кода нет, а списочные вызовы вообще
 * не обёрнуты в перехват — их текст уезжал в stderr как есть. Битрикс24 цитирует присланное
 * значение в ошибке валидации, и хотя у списочных вызовов присылать нечего, держать здесь
 * обещание, которое код не выполняет, — способ однажды обнаружить это на настоящих данных.
 * Нашла проверка безопасности в PR #50.
 */
export function hookCall(base: string): RestCall {
  const root = base.endsWith('/') ? base : `${base}/`

  return async (method, params = {}) => {
    const response = await fetch(`${root}${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    })

    // ⚠ Не-2xx с телом портала (`refusalCodeIn`) — отказ ПОРТАЛА, а не беда связи. Ошибки метода,
    // по документации, приходят «с 400 или 403»: так ответили `crm.activity.layout.blocks.set`
    // вебхуком (400, `ERROR_WRONG_CONTEXT`), `crm.activity.todo.update` по закрытому делу (400)
    // и `app.option.get` вебхуком (403, `ACCESS_DENIED`) — замерено 29.09. Поднимаем его с кодом,
    // как двухсотый: иначе `safeRefusal` его не назвал бы, и проверка рапортовала бы беду связи.
    // Прежде отказом считался только 400, и 403 отправлял оператора проверять адрес вебхука
    // (`/review` в закрывающем круге панели PR #106). Кроме 401: это отказ в авторизации самого
    // вебхука (`NO_AUTH_FOUND`, `INVALID_CREDENTIALS`), и подсказка ниже полезнее кода. Остальное —
    // страница, пустое тело — беда ДО портала: прокси, опечатка в адресе, погашенный вебхук.
    if (!response.ok) {
      const refusal = response.status !== 401 ? refusalIn(await response.json().catch(() => null)) : null
      if (refusal !== null) throw refusal
      // ⚠ `Stop`, а не голый `Error`: текст здесь НАШ, и `report` печатает его как есть.
      // Пройдя через `safeRefusal`, понятное «портал ответил 502» схлопнулось бы
      // в «код не распознан» — то есть фильтр, заведённый против чужой прозы, съел бы
      // единственную полезную подсказку.
      throw new Stop(`\nПортал ответил ${response.status} на ${method}. Проверьте адрес вебхука и то, что он ещё жив.`, 1)
    }

    let body: unknown
    try {
      body = await response.json()
    }
    catch {
      // Страница или пустое тело при 2xx — не ответ портала. Голый `SyntaxError` дошёл бы до `report`
      // как «беда на нашей стороне» — ложный диагноз (`/code-review` в закрывающем круге панели PR #106).
      throw new PortalError(UNREACHABLE_CODE, `${method}: ответ портала — не JSON`)
    }
    const answer = (body !== null && typeof body === 'object' ? body : {}) as { error?: unknown }
    // Пустой `error` при 2xx отказом не считаем, как не считает и SDK: такой ответ без `result` ловит
    // проверка ниже. Двум путям к порталу расходиться нельзя (см. `hookBatch`).
    const refusal = answer.error === '' ? null : refusalIn(body)
    if (refusal !== null) throw refusal
    // ⚠ Успех — это ответ С `result` («Коды ошибок»), тот же предохранитель, что у `makePortalCall`.
    // Без него ответ 2xx без результата — страница, пустой `"error": ""` — уезжал к переносу успехом,
    // и пустое чтение значило бы «шаблонов нет»: записал бы второй. `/review` в панели PR #106.
    if (!('result' in answer)) throw new PortalError(UNREACHABLE_CODE, `${method}: в ответе портала нет результата`)
    // ⚠ Наружу — та же форма, что у `makePortalCall`: `result`, `time` и `next` списков. Вебхук отдавал
    // тело целиком, и в этом расхождении прожил #110 — живые проверки видели `next`, а бой нет. Кто
    // однажды прочтёт `total`, должен упасть уже в проверке, а не в бою (`/code-review` в PR #113).
    const { result, time, next } = answer as { result?: unknown, time?: unknown, next?: unknown }
    return next === undefined ? { result, time } : { result, time, next }
  }
}

/**
 * A portal refusal in an answer body, with `""` and `"0"` named `REJECTED_CODE`; `null` — the body is not one.
 *
 * Разбор тела — общий с вызовами через SDK (`refusalCodeIn`): отказ портала — только документированная
 * форма, а проза, чужой JSON и наш код в чужом теле — не он. Прежде вебхук брал любую строку из `error`,
 * и `report` печатал её в терминал оператора как есть — вместе с управляющими последовательностями
 * (безопасность в закрывающем круге панели PR #106). Пустой код и `"0"` — окончательный отказ без имени:
 * `"error": ""` документирован у `crm.activity.update`, `"0"` портал прислал 29.09 на правку закрытого
 * дела (HTTP 400); при 2xx SDK читает `"0"` так же.
 */
function refusalIn(body: unknown): PortalError | null {
  const named = refusalCodeIn(body)
  if (named === null) return null
  const description = (body as { error_description?: unknown }).error_description
  return new PortalError(named === '' ? REJECTED_CODE : named, typeof description === 'string' ? description : '')
}

/**
 * Пакетный вызов тем же вебхуком.
 *
 * ⚠ Собирается ВРУЧНУЮ, а не через `b24.actions.v2.batch`: SDK строится вокруг OAuth-клиента
 * приложения, а у вебхука ни `clientId`, ни `memberId` — поднимать его ради одного пакета
 * значит подсовывать ему выдуманный грант. Форма конверта при этом взята не из головы:
 * `cmd` — карта «имя команды → `метод?параметры`», `halt: 0`, ответ раскладывается на
 * `result.result` и `result.result_error`. Проверено на живом портале 23.09, включая
 * подстановку `$result[…]` и percent-encoding параметров.
 *
 * ⚠ Наружу отдаём ТОЛЬКО успешные команды — ровно как рабочий `batch` в `server/b24/client.ts`.
 * Отсутствие ключа и есть признак отказа; расходиться этим двум реализациям нельзя, иначе
 * проверка будет доказывать не то поведение, которое у приложения в бою.
 */
export function hookBatch(base: string): RestBatch {
  const call = hookCall(base)

  return async (calls: Record<string, PortalCall>) => {
    const cmd: Record<string, string> = {}
    for (const [name, command] of Object.entries(calls)) {
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(command.params)) query.set(key, String(value))
      cmd[name] = `${command.method}?${query.toString()}`
    }

    const answer = await call('batch', { halt: 0, cmd }) as {
      result?: { result?: Record<string, unknown>, result_error?: Record<string, unknown> }
    }

    // Только имена наших команд: ключи `result_error` приходят из тела, и печатать их как есть нельзя.
    const failed = Object.keys(answer.result?.result_error ?? {}).filter(name => Object.hasOwn(calls, name))
    if (failed.length > 0) console.warn(`  · команды пакета не отработали: ${failed.join(', ')}`)

    return answer.result?.result ?? {}
  }
}

/**
 * Напечатать беду и вернуть код выхода. Единственная точка, где что-то уходит наружу при отказе.
 *
 * ⚠ Отказ портала проходит через `safeRefusal` — здесь это уже не украшение, а то самое
 * обещание из комментария к `hookCall`. Без него проза портала (а он цитирует присланное
 * значение) печаталась бы в терминал и уезжала в `| tee`.
 *
 * ⚠ `Stop` печатается как есть: это НАШ текст, написанный для оператора, и пропускать его
 * через фильтр кодов значило бы схлопнуть подробную инструкцию в «код не распознан».
 *
 * ⚠ ТРИ ИСХОДА, А НЕ ДВА, и третий оплачен потерянным вечером. Раньше всё, что не `Stop`,
 * уходило в `safeRefusal`, а он по построению схлопывает незнакомое в «портал отказал, код
 * не распознан». Живьём этой фразой упала проверка, у которой просто не была поднята
 * локальная база: `ECONNREFUSED` на 5432 отрапортовался как отказ портала, и следующие
 * двадцать минут ушли на портал — туда, где всё было в порядке. Диагноз, уводящий не в ту
 * сторону, хуже отсутствующего: без него человек хотя бы смотрит на стек.
 */
export function report(error: unknown): number {
  if (error instanceof Stop) {
    console.error(error.message)
    return error.code
  }

  if (!(error instanceof PortalError)) {
    console.error(`\nНе получилось, и это НЕ отказ портала: ${localFailure(error)}.`)
    console.error('Беда на нашей стороне — база, сеть, окружение. Портал тут ни при чём.')
    return 1
  }

  // ⚠ Машинный код печатается РЯДОМ с фразой, когда фраза его не называет. `safeRefusal` схлопывает
  // всё, чего нет в его списке, в одну строку — и правильно делает: список защищает вывод
  // от чужой прозы, в которой едет присланное значение. Но у операторского скрипта другой
  // читатель: человек выбирает между «чинить права», «чинить вызов» и «подождать», и без
  // кода выбрать нечем. Печатается КОД, прошедший форму кода портала (`refusalCodeIn`), и форма
  // проверяется здесь ещё раз: это граница вывода в терминал, и управляющей последовательности
  // из чужого тела в ней быть не должно (безопасность в закрывающем круге панели PR #106).
  const said = safeRefusal(error)
  const detail = said !== error.code && /^\w{1,64}$/.test(error.code) ? ` (${error.code})` : ''
  console.error(`\nНе получилось: ${said}${detail}`)
  return 1
}

/**
 * Как назвать беду, которая случилась у НАС.
 *
 * ⚠ Наружу идут только имя класса и машинный код — ни байта текста ошибки. Соблазн напечатать
 * `error.message` здесь велик и ровно здесь опасен: до этой ветки доходит в том числе ошибка
 * доставки ответа, а её текст способен нести присланное респондентом значение.
 * Имени класса (`DrizzleQueryError`) и кода (`ECONNREFUSED`) хватает, чтобы понять, куда идти.
 */
function localFailure(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : typeof error
  const code = systemCode(error)
  return code === '' ? name : `${name}, ${code}`
}

/** Форма машинного кода Node и драйверов: `ECONNREFUSED`, `ETIMEDOUT`, `23505`. */
const SYSTEM_CODE = /^[A-Z][A-Z0-9_]{2,31}$/

/**
 * Достать машинный код из цепочки `cause`.
 *
 * ⚠ Цепочка, а не одно поле: обёртки прячут причину вглубь. `DrizzleQueryError` своего `code`
 * не имеет вовсе, а `ECONNREFUSED` лежит у него в `cause` — то есть по верхнему уровню
 * не видно ровно того, ради чего всё и затевалось. Глубина ограничена: `cause` бывает
 * циклическим.
 */
function systemCode(error: unknown, depth = 0): string {
  if (depth > 4 || error === null || typeof error !== 'object') return ''

  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && SYSTEM_CODE.test(code)) return code

  return systemCode((error as { cause?: unknown }).cause, depth + 1)
}
