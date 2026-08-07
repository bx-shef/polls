import { describe, expect, it } from 'vitest'
import { isSameOriginWrite, CROSS_ORIGIN_MESSAGE } from '../src/api/csrf'

describe('isSameOriginWrite — защита записи от подделки с чужого сайта', () => {
  describe('Sec-Fetch-Site — основной сигнал (браузер шлёт всегда, из JS не подделать)', () => {
    it('same-origin → пропускаем (наша же страница)', () => {
      expect(isSameOriginWrite({ secFetchSite: 'same-origin' })).toBe(true)
      expect(isSameOriginWrite({ secFetchSite: 'Same-Origin' })).toBe(true) // регистр не важен
    })

    it('cross-site / same-site / none → отказ', () => {
      // same-site тоже отказ: поддомен того же сайта нам не свой, а `none` для POST означает,
      // что запрос не инициирован страницей приложения.
      for (const site of ['cross-site', 'same-site', 'none']) {
        expect(isSameOriginWrite({ secFetchSite: site })).toBe(false)
      }
    })

    it('имеет приоритет над Origin (заголовок надёжнее)', () => {
      expect(isSameOriginWrite({ secFetchSite: 'cross-site', origin: 'https://polls.example.com', host: 'polls.example.com' })).toBe(false)
    })
  })

  describe('Origin — запасной сигнал, когда Sec-Fetch-Site не прислали', () => {
    it('совпал с хостом → пропускаем', () => {
      expect(isSameOriginWrite({ origin: 'https://polls.example.com', host: 'polls.example.com' })).toBe(true)
    })

    it('схема не мешает сверке (за прокси приложение видит http, снаружи https)', () => {
      expect(isSameOriginWrite({ origin: 'http://polls.example.com', host: 'polls.example.com' })).toBe(true)
    })

    it('чужой хост → отказ', () => {
      expect(isSameOriginWrite({ origin: 'https://evil.example', host: 'polls.example.com' })).toBe(false)
    })

    it('порт — часть хоста, различие даёт отказ', () => {
      expect(isSameOriginWrite({ origin: 'https://polls.example.com:8443', host: 'polls.example.com' })).toBe(false)
    })

    it('Origin: null (sandbox-iframe, редирект) → отказ, это доказательство чужого источника', () => {
      expect(isSameOriginWrite({ origin: 'null', host: 'polls.example.com' })).toBe(false)
    })

    it('нераспознанный Origin → отказ (не доверяем непонятному)', () => {
      expect(isSameOriginWrite({ origin: 'javascript:alert(1)', host: 'polls.example.com' })).toBe(false)
      expect(isSameOriginWrite({ origin: 'https://a.example/path', host: 'a.example' })).toBe(false)
    })
  })

  describe('политика «отказ по доказательству, а не по отсутствию»', () => {
    it('нет ни одного заголовка → пропускаем', () => {
      // Осознанный компромисс: строгий отказ ломал бы клиентов без заголовков ради сценария,
      // которого у современного атакующего нет — браузер пришлёт хотя бы Origin.
      expect(isSameOriginWrite({})).toBe(true)
      expect(isSameOriginWrite({ secFetchSite: null, origin: null, host: null })).toBe(true)
      expect(isSameOriginWrite({ secFetchSite: '', origin: '  ' })).toBe(true)
    })

    it('Origin есть, а Host не с чем сверить → пропускаем', () => {
      expect(isSameOriginWrite({ origin: 'https://polls.example.com' })).toBe(true)
    })
  })

  it('текст отказа говорит, что случилось и что делать дальше', () => {
    expect(CROSS_ORIGIN_MESSAGE).toMatch(/не со страницы приложения/)
    expect(CROSS_ORIGIN_MESSAGE).toMatch(/Откройте приложение заново/)
  })
})
