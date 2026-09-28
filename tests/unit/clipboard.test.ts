// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyToClipboard } from '../../app/utils/clipboard'

/**
 * Копирование в буфер обмена — `app/utils/clipboard.ts`.
 *
 * ⚠ Гвард под дефект живой проверки 28.09 (issue #84, п. 4): портал встраивает приложение без
 * разрешения `clipboard-write`, Clipboard API во фрейме отказывает, а кнопка «Скопировать» этот
 * отказ глотала — нажатие не давало ничего. Здесь проверяется ровно тот случай: API отказал,
 * копирование всё равно состоялось вторым путём, и об успехе сказано правдой.
 *
 * Окружение — happy-dom, а не Nuxt: помощнику нужен документ, а не приложение, и поднимать
 * Nuxt ради трёх проверок незачем (почему он дорог — `vitest.config.ts`).
 */

/**
 * Что увидел `execCommand` в момент копирования: команду и ВЫДЕЛЕННЫЙ текст.
 *
 * Выделенный, а не просто лежащий в поле: браузер копирует выделение, и поле с текстом, но без
 * выделения, дало бы пустой буфер при ответе «скопировано».
 */
let copied: { command: string, selected: string }[]
let execResult: () => boolean
let writeText: ReturnType<typeof vi.fn>

beforeEach(() => {
  copied = []
  execResult = () => true
  writeText = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: (command: string) => {
      const area = document.querySelector('textarea')
      const selected = area === null ? '' : area.value.slice(area.selectionStart, area.selectionEnd)
      copied.push({ command, selected })
      return execResult()
    },
  })
})

afterEach(() => {
  // Свои подмены — своими руками: иначе следующий файл того же процесса увидел бы их.
  Reflect.deleteProperty(navigator, 'clipboard')
  Reflect.deleteProperty(document, 'execCommand')
  document.body.innerHTML = ''
})

describe('копирование в буфер обмена', () => {
  it('буфер открыт — копирует им, запасной путь не трогает', async () => {
    expect(await copyToClipboard('https://опрос.рф/s/abc')).toBe(true)

    expect(writeText).toHaveBeenCalledWith('https://опрос.рф/s/abc')
    expect(copied).toEqual([])
  })

  it('ГЛАВНОЕ: фрейм закрыл буфер — копирует вторым путём и говорит «скопировано»', async () => {
    // Ровно так отвечает браузер во фрейме портала без `clipboard-write`.
    writeText.mockRejectedValueOnce(new DOMException('Write permission denied.', 'NotAllowedError'))

    expect(await copyToClipboard('https://опрос.рф/s/abc')).toBe(true)

    expect(copied).toEqual([{ command: 'copy', selected: 'https://опрос.рф/s/abc' }])
  })

  it('вне защищённого контекста, где буфера нет вовсе, — тоже вторым путём', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })

    expect(await copyToClipboard('текст')).toBe(true)
    expect(copied).toHaveLength(1)
  })

  it.each<[string, () => boolean]>([
    ['команда отказала', () => false],
    ['команда бросила исключение', () => { throw new Error('не поддерживается') }],
  ])('не вышло ни так, ни так — честное `false` (%s)', async (_case, result) => {
    // На `false` вызывающий выделяет адрес и говорит, какие клавиши нажать. Ответ «успех»
    // здесь вернул бы ровно прежнюю немую кнопку, только с надписью «Скопировано».
    writeText.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))
    execResult = result

    expect(await copyToClipboard('текст')).toBe(false)
  })

  it('убирает временное поле и возвращает фокус туда, где он был', async () => {
    // Иначе в документе копились бы невидимые поля с адресами анкет, а человек, копировавший
    // с клавиатуры, оставался бы с фокусом «нигде».
    const button = document.createElement('button')
    document.body.appendChild(button)
    button.focus()
    writeText.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'))

    await copyToClipboard('текст')

    expect(document.querySelectorAll('textarea')).toHaveLength(0)
    expect(document.activeElement).toBe(button)
  })
})
