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
import { PortalError } from '../server/domain/portals/portal-error'
import { safeRefusal } from '../server/domain/answers/portal-errors'
import type { RestCall } from '../server/b24/provision'

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

    // ⚠ Битрикс24 отдаёт свои отказы двухсотым с полем `error`, поэтому не-2xx здесь означает
    // беду ДО портала: прокси, опечатку в адресе, погашенный вебхук. Тела у неё может не быть
    // вовсе, а может быть страница — разбирать её как JSON бессмысленно.
    if (!response.ok) {
      // ⚠ `Stop`, а не голый `Error`: текст здесь НАШ, и `report` печатает его как есть.
      // Пройдя через `safeRefusal`, понятное «портал ответил 502» схлопнулось бы
      // в «код не распознан» — то есть фильтр, заведённый против чужой прозы, съел бы
      // единственную полезную подсказку.
      throw new Stop(`\nПортал ответил ${response.status} на ${method}. Проверьте адрес вебхука и то, что он ещё жив.`, 1)
    }

    const body = await response.json() as { error?: string, error_description?: string }
    if (typeof body.error === 'string' && body.error !== '') {
      throw new PortalError(body.error, body.error_description ?? '')
    }
    return body
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
 */
export function report(error: unknown): number {
  if (error instanceof Stop) {
    console.error(error.message)
    return error.code
  }
  console.error(`\nНе получилось: ${safeRefusal(error)}`)
  return 1
}
