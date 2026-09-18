import { mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it } from 'vitest'
import IndexPage from '../../app/pages/index.vue'

/**
 * Лендинг — единственная страница проекта, которой место в поисковой выдаче, и единственная,
 * которую человек видит до установки приложения.
 *
 * ⚠ Раньше здесь стояла заглушка каркаса с состоянием базы и Redis, и она же была указана
 * в карточке Маркета как ссылка на приложение: портал показывал бы сотруднику отладочную
 * панель, а поисковик индексировал бы её как главную страницу продукта. Тесты ниже держат
 * то, нарушение чего стоит дорого: обещание продукта и отсутствие служебного.
 */

describe('лендинг', () => {
  it('говорит, что делает продукт, а не как ему живётся', () => {
    const page = mountSuspended(IndexPage)
    return page.then((p) => {
      const text = p.text()

      expect(text).toContain('Опросы клиентов')
      expect(text).toContain('стадии сделки')
      // Ни базы, ни Redis, ни версии сборки: это служебное и на лендинге ему не место.
      expect(text).not.toContain('Redis')
      expect(text).not.toContain('Каркас')
    })
  })

  it('обещает то же, что карточка Маркета', () => {
    // Расходиться им нельзя: это одно обещание, данное в двух местах. Формулировки
    // взяты из `docs/market-graphics.md`, где они согласованы владельцем.
    return mountSuspended(IndexPage).then((p) => {
      const text = p.text()

      expect(text).toContain('Без регистрации')
      expect(text).toContain('Ответы остаются в вашем Битрикс24')
    })
  })

  it('называет порог, ниже которого срез не показывается', () => {
    // Инвариант проекта: срез не показывается, пока в нём меньше пяти ответов. Обещать
    // на лендинге отчётность и умолчать об этом — обещать то, чего продукт не делает.
    return mountSuspended(IndexPage).then(p => expect(p.text()).toContain('пяти ответов'))
  })

  it('не оставляет неподставленных значений', () => {
    return mountSuspended(IndexPage).then((p) => {
      expect(p.text()).not.toContain('undefined')
      expect(p.text()).not.toContain('[object Object]')
    })
  })
})
