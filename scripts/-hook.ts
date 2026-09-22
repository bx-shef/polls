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
 * ⚠ Ошибка портала поднимается исключением с КОДОМ в тексте: наверху её пропустит через
 * `safeRefusal`, который знает закрытый список кодов и наружу лишнего не выпустит.
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
      throw new Error(`портал ответил ${response.status} на ${method}`)
    }

    const body = await response.json() as { error?: string, error_description?: string }
    if (typeof body.error === 'string' && body.error !== '') {
      throw new Error(`${body.error}: ${body.error_description ?? ''}`)
    }
    return body
  }
}
