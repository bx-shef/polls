import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  DESCRIPTION_MAX,
  DESCRIPTION_MIN,
  LANDING_DEMO_SURVEY,
  LANDING_DESCRIPTION,
  LANDING_FEATURES,
  LANDING_MARKET_CODE,
  LANDING_SECTIONS,
  LANDING_SITE_URL,
  LANDING_STEPS,
  marketUrl
} from '../app/utils/landing'
import { SURVEY_KEY } from '../src/demo/seed'

/**
 * Константы витрины лежат в `app/`, куда порог покрытия не смотрит (`vitest.config.ts` включает
 * только `src/**`), а визуальный гейт в `pnpm check` не входит. То есть до этого файла продающие
 * тексты и адрес Маркета не проверялись НИЧЕМ — притом что это единственное, что видит покупатель.
 *
 * Файл не имеет импортов из Nuxt и берётся обычным vitest как есть.
 */
describe('константы витрины', () => {
  it('кнопка лендинга ведёт на опрос, который реально засеян', () => {
    // Ключ приходится дублировать: гард границы `~core` запрещает тянуть `~core/demo` в `app/**`.
    // Значит его нужно пинить тестом, иначе переименование сида молча ломает единственный CTA.
    expect(LANDING_DEMO_SURVEY).toBe(SURVEY_KEY)
  })

  it('описание укладывается в окно, которое ждут валидаторы карточек', () => {
    // Константы DESCRIPTION_MIN/MAX выглядели ограничением, но не ограничивали ничего.
    expect(LANDING_DESCRIPTION.length).toBeGreaterThanOrEqual(DESCRIPTION_MIN)
    expect(LANDING_DESCRIPTION.length).toBeLessThanOrEqual(DESCRIPTION_MAX)
  })

  it('адрес карточки Маркета собирается из кода приложения', () => {
    // Кнопки Маркета на лендинге нет вовсе (добавится PR-ом в день публикации), то есть ссылку
    // не рендерит ни один тест и ни одна среда — проверяем хотя бы форму адреса заранее.
    expect(marketUrl()).toBe(`https://www.bitrix24.ru/apps/app/${LANDING_MARKET_CODE}/`)
    expect(() => new URL(marketUrl())).not.toThrow()
  })

  it('канонический адрес — валидный https без хвостового слеша', () => {
    const u = new URL(LANDING_SITE_URL)
    expect(u.protocol).toBe('https:')
    expect(LANDING_SITE_URL.endsWith('/')).toBe(false)
  })

  it('кнопки «Установить из Маркета» на лендинге НЕТ, пока слаг не занят', () => {
    // Флага под кнопку больше нет (решение владельца, 2026-08-22: прежний `MARKET_PUBLISHED` снят
    // как лишняя ручка). Сторожим само отсутствие: кнопка на незанятый слаг вела бы в 404 Маркета —
    // первое, что увидел бы заинтересовавшийся человек, была бы наша ошибка. В день публикации этот
    // тест меняется вместе с добавлением кнопки (адрес — `marketUrl()`), с пересъёмкой эталонов.
    const src = readFileSync(resolve(process.cwd(), 'app/pages/index.vue'), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
    expect(src).not.toContain('Установить из Маркета')
    expect(src).not.toContain('marketUrl(')
  })

  it('витрина не обещает того, что ещё не отгружено', () => {
    // Мерж = публикация на живой домен (авто-CD). Доставка приглашения в таймлайн (#126) и возврат
    // сводки в карточку сделки (#18) написаны, но НИ РАЗУ не прогонялись на реальном портале, поэтому
    // на витрине их по-прежнему быть не должно.
    // ⚠️ Прежнее обоснование («второе конфликтует с обещанием анонимности, пока нет гейта постинга»)
    // снято: гейт написан и вынесен в конструктор. Взамен он поменял ДРУГОЕ — витрина больше не
    // называет опрос анонимным без оговорки, потому что возврат результата в карточку включён по
    // умолчанию и порог «меньше пяти» на него не распространяется.
    const texts = [
      LANDING_DESCRIPTION,
      ...LANDING_STEPS.flatMap((s) => [s.title, s.text]),
      ...LANDING_FEATURES.flatMap((f) => [f.title, f.text]),
      // Секции — тоже сюда: именно в них инлайном жили «без участия человека» и «на вашем сервере».
      ...Object.values(LANDING_SECTIONS).flatMap((s) => Object.values(s))
    ].join(' ').toLowerCase()

    for (const forbidden of [
      'таймлайн', 'уходит сам', 'уходит клиенту сам', 'на вашем сервере',
      'без участия человека', 'проходит путь само', 'в карточку сделки'
    ]) {
      expect(texts, `витрина обещает «${forbidden}» — этого в продукте ещё нет`).not.toContain(forbidden)
    }
  })
})
