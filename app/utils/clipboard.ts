/**
 * Copies text to the clipboard: the Clipboard API first, the selection-and-`execCommand` path second.
 *
 * ⚠ ВТОРОЙ ПУТЬ — НЕ ДЛЯ СТАРЫХ БРАУЗЕРОВ, А ДЛЯ НАС САМИХ. Портал встраивает приложение в iframe
 * без разрешения `clipboard-write`, и `navigator.clipboard.writeText` там отказывает в любом
 * современном браузере. Прежняя кнопка «Скопировать» этот отказ глотала: человек нажимал — и не
 * происходило ничего, а комментарий в коде честно признавал, что кнопка «ничего не даёт»
 * (issue #84, п. 4). `document.execCommand('copy')` разрешения фрейма не спрашивает: ему нужен
 * только жест пользователя, а он есть — копируют по нажатию. Приём у соседа (`client-bank-alfa-by`,
 * `app/utils/clipboard.ts`), и там он работает внутри того же фрейма портала.
 *
 * ⚠ `execCommand` объявлен устаревшим, и когда-нибудь браузер его уберёт. Поэтому он второй, а не
 * единственный, и поэтому функция честно отвечает `false`, а не молчит: вызывающий обязан на это
 * ответить — выделить текст и сказать, какие клавиши нажать.
 *
 * @returns `true` — текст в буфере обмена; `false` — не удалось ни одним путём.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // Only a click handler calls this, but a server render must not reach for `document` anyway.
  if (typeof document === 'undefined') return false

  try {
    await navigator.clipboard.writeText(text)
    return true
  }
  catch {
    // Отказ фрейма — штатный случай внутри портала, а не ошибка. Сюда же попадает страница вне
    // защищённого контекста, где `navigator.clipboard` нет вовсе. Оба раза — вторым путём.
  }

  return copyThroughSelection(text)
}

/** Copies through a hidden textarea: select its text and ask the browser to copy the selection. */
function copyThroughSelection(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  // ⚠ `fixed` в левом верхнем углу, а не просто в конце документа: выделение переводит фокус
  // на поле, и поле за краем экрана браузер прокрутил бы в видимость — вкладка дёрнулась бы
  // на ровном месте.
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;'

  // ⚠ Фокус возвращается туда, где был. Выделение уводит его на временное поле, а поле тут же
  // удаляется — и человек, копировавший с клавиатуры, оставался бы с фокусом «нигде».
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  document.body.appendChild(area)
  try {
    area.select()
    return document.execCommand('copy')
  }
  catch {
    return false
  }
  finally {
    area.remove()
    focused?.focus()
  }
}
