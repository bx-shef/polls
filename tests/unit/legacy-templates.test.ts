import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readLegacyTemplates, type LegacyOption } from '../../server/domain/import/legacy-templates'

/**
 * Разбор проверяется на НАСТОЯЩЕЙ конфигурации заказчика, а не на придуманной.
 *
 * `legacy/questionary-structure.txt` — реконструкция выгрузки `b_option`: одиннадцать анкет
 * из двенадцати (`digital` не попала). Строка — `questionary_group_<код>`, табуляция, JSON.
 * Придуманные фикстуры здесь бесполезны: половина ловушек этого источника — про то, что
 * одно и то же поле в соседних анкетах приезжает то строкой, то числом.
 */

const STRUCTURE_PATH = fileURLToPath(new URL('../../legacy/questionary-structure.txt', import.meta.url))

function realOptions(): LegacyOption[] {
  return readFileSync(STRUCTURE_PATH, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map((line) => {
      const tab = line.indexOf('\t')
      return { name: line.slice(0, tab), value: line.slice(tab + 1) }
    })
}

describe('настоящая конфигурация заказчика', () => {
  const { templates, warnings } = readLegacyTemplates(realOptions())

  it('разбирает все одиннадцать анкет реконструкции', () => {
    expect(templates.map(t => t.code)).toEqual([
      'brand', 'concept', 'creativity', 'design', 'game', 'identity',
      'media', 'package', 'productionsupervision', 'strategy', 'video',
    ])
  })

  it('веса в каждой оценочной секции дают ровно 100', () => {
    // Факт из разбора источника: ни одной секции с суммой ≠ 100 по всем анкетам.
    // Если разбор весов сломается — строкой `SIZE` вместо числа или наоборот, — сумма поедет,
    // и это единственная проверка, которая поймает такую поломку на всём объёме сразу.
    expect(warnings.filter(w => w.code === 'weights-not-100')).toEqual([])

    for (const template of templates) {
      for (const section of template.sections.filter(s => s.scored)) {
        const total = section.questions.filter(q => q.scored).reduce((sum, q) => sum + q.weight, 0)
        expect(`${template.code}/${section.key}: ${total}`).toBe(`${template.code}/${section.key}: 100`)
      }
    }
  })

  it('расщепляет вопрос, стоящий в двух секциях анкеты game', () => {
    // Дефект источника: UF_HQ_PROC_REG стоит в «Продукте» с весом 50 и в «Процессах» с весом 40.
    // Один ответ клиента влиял на два балла. Ключ вопроса уникален внутри версии — инвариант.
    const game = templates.find(t => t.code === 'game')!
    const twins = game.sections.flatMap(s => s.questions).filter(q => q.sourceKey === 'UF_HQ_PROC_REG')

    expect(twins.map(q => q.key)).toEqual(['UF_HQ_PROC_REG__product', 'UF_HQ_PROC_REG__process'])
    expect(twins.map(q => q.weight)).toEqual([50, 40])
    // Общий sourceKey — то, ради чего всё: обоим отдаётся одно значение, и баллы сходятся.
    expect(new Set(twins.map(q => q.sourceKey)).size).toBe(1)
  })

  it('жалуется на расщепление ровно один раз, а не на каждое вхождение', () => {
    const split = warnings.filter(w => w.code === 'question-split')

    expect(split).toHaveLength(1)
    expect(split[0]).toMatchObject({ template: 'game', at: 'UF_HQ_PROC_REG' })
  })

  it('ключи вопросов уникальны внутри каждого шаблона', () => {
    // Инвариант проекта. В источнике он нарушен, и расщепление существует ровно ради него.
    for (const template of templates) {
      const keys = template.sections.flatMap(s => s.questions).map(q => q.key)
      expect(`${template.code}: ${keys.length}`).toBe(`${template.code}: ${new Set(keys).size}`)
    }
  })

  it('превращает вес 0 в явный флаг «не идёт в оценку»', () => {
    // В источнике это был способ выключить вопрос, неотличимый от опечатки.
    const zero = warnings.filter(w => w.code === 'zero-weight')

    expect(zero.map(w => `${w.template}/${w.at}`)).toEqual([
      'concept/UF_HQ_PERS_CREAT',
      'design/UF_HQ_PERS_CREAT',
      'identity/UF_HQ_IDENTITY_8',
    ])

    const concept = templates.find(t => t.code === 'concept')!
    const off = concept.sections.flatMap(s => s.questions).find(q => q.key === 'UF_HQ_PERS_CREAT')!
    expect(off).toMatchObject({ type: 'scale', weight: 0, scored: false })
  })

  it('переносит единственный вопрос-дату текстом и говорит об этом', () => {
    const media = templates.find(t => t.code === 'media')!
    const date = media.sections.flatMap(s => s.questions).find(q => q.key === 'UF_HQ_QUEST_NDATE')!

    expect(date.type).toBe('date')
    expect(warnings.filter(w => w.code === 'date-as-text').map(w => `${w.template}/${w.at}`))
      .toEqual(['media/UF_HQ_QUEST_NDATE'])
  })

  it('читает границы шкалы и когда они строки, и когда числа', () => {
    // brand отдаёт MIN/MAX строками, concept — числами. В одном и том же файле.
    const brand = templates.find(t => t.code === 'brand')!
    const concept = templates.find(t => t.code === 'concept')!

    expect(brand.sections[0]!.questions[0]!.scale).toEqual({ min: 0, max: 10 })
    expect(concept.sections[0]!.questions[0]!.scale).toEqual({ min: 0, max: 10 })
    expect(brand.sections[0]!.questions[0]!.weight).toBe(30)
    expect(concept.sections[0]!.questions[0]!.weight).toBe(50)
  })

  it('отличает оценочные секции от секции открытых вопросов', () => {
    const brand = templates.find(t => t.code === 'brand')!

    expect(brand.sections.map(s => s.key)).toEqual(['product', 'process', 'personal', 'open'])
    expect(brand.sections.map(s => s.scored)).toEqual([true, true, true, false])
    // Текстовые вопросы в балл не идут никогда, независимо от секции.
    expect(brand.sections[3]!.questions.every(q => q.type === 'text' && !q.scored)).toBe(true)
  })

  it('не выдумывает формулировок: без подписей заголовки пустые', () => {
    // В конфигурации NAME пустой у всех полей — текст вопроса лежит в b_user_field_lang.
    // Пустой заголовок виден в отчёте; выдуманный по коду — нет.
    expect(templates.flatMap(t => t.sections).flatMap(s => s.questions).every(q => q.title === '')).toBe(true)
  })

  it('подставляет формулировки из подписей полей', () => {
    const labels = [{ template: 'brand', field: 'UF_HQ_PROD_ANALYT', title: 'Аналитика продукта' }]
    const withTitles = readLegacyTemplates(realOptions(), labels)
    const brand = withTitles.templates.find(t => t.code === 'brand')!

    expect(brand.sections[0]!.questions[0]!.title).toBe('Аналитика продукта')
  })
})

describe('реестр типов', () => {
  const groups = realOptions().filter(o => o.name === 'questionary_group_brand')

  it('берёт название анкеты из объекта', () => {
    const options = [...groups, { name: 'questionary_list', value: '{"brand":"Бренд-платформа"}' }]

    expect(readLegacyTemplates(options).templates[0]!.title).toBe('Бренд-платформа')
  })

  it('берёт название анкеты из списка', () => {
    const options = [...groups, { name: 'questionary_list', value: '[{"CODE":"BRAND","NAME":"Бренд-платформа"}]' }]

    expect(readLegacyTemplates(options).templates[0]!.title).toBe('Бренд-платформа')
  })

  it('без реестра подставляет код, а не пустую строку', () => {
    // Пустой заголовок в списке шаблонов на портале выглядит как поломка импорта.
    expect(readLegacyTemplates(groups).templates[0]!.title).toBe('brand')
  })

  it('не падает на испорченном реестре', () => {
    const options = [...groups, { name: 'questionary_list', value: 'не json' }]

    expect(readLegacyTemplates(options).templates[0]!.title).toBe('brand')
  })
})

describe('испорченная конфигурация анкеты', () => {
  it('не теряет остальные анкеты и говорит, какая не разобралась', () => {
    const options = [
      { name: 'questionary_group_broken', value: '{не json' },
      ...realOptions().filter(o => o.name === 'questionary_group_brand'),
    ]

    const { templates, warnings } = readLegacyTemplates(options)

    expect(templates.map(t => t.code)).toEqual(['brand'])
    expect(warnings.filter(w => w.code === 'field-mismatch')).toHaveLength(1)
  })
})

describe('диапазоны интерпретации', () => {
  // ⚠ Синтетические данные: TERMS заполнены только у анкеты digital, а она в реконструкцию
  // не попала. Форма взята из разбора источника — шесть диапазонов, нижняя граница 4,
  // текст готовым HTML с классами landing24.
  const withTerms = (terms: unknown) => [{
    name: 'questionary_group_digital',
    value: JSON.stringify([{ NAME: 'Процессы', FIELD: 'PROPERTY_PROCESS', TERMS: terms, FIELDS: [
      { CODE: 'UF_HQ_D_1', NAME: '', TYPE: 'POINT', SETTING: { MIN: '0', MAX: '10', SIZE: '100' } },
    ] }]),
  }]

  it('вычищает HTML до текста и говорит об этом', () => {
    const terms = [{ MIN: '4', MAX: '6', TEXT: '<p class="g-color-white">Где-то мы <b>свернули</b> не туда</p>' }]

    const { templates, warnings } = readLegacyTemplates(withTerms(terms))

    expect(templates[0]!.sections[0]!.bands[0]).toEqual({ from: 4, to: 6, text: 'Где-то мы свернули не туда' })
    expect(warnings.filter(w => w.code === 'html-stripped')).toHaveLength(1)
  })

  it('не считает дырой смежные границы', () => {
    // В источнике диапазоны стыкуются: 6–7.5, затем 7.5–8. Это не разрыв.
    const terms = [{ MIN: 6, MAX: 7.5, TEXT: 'а' }, { MIN: 7.5, MAX: 8, TEXT: 'б' }]

    expect(readLegacyTemplates(withTerms(terms)).warnings.filter(w => w.code === 'band-gap')).toEqual([])
  })

  it('сообщает о настоящем разрыве шкалы', () => {
    // Клиент с оценкой в непокрытом отрезке не увидит никакого текста — так было у digital
    // ниже четвёрки. Чинить чужие данные догадкой нельзя, но молчать о дыре тоже.
    const terms = [{ MIN: 4, MAX: 6, TEXT: 'а' }, { MIN: 8, MAX: 10, TEXT: 'б' }]

    const gaps = readLegacyTemplates(withTerms(terms)).warnings.filter(w => w.code === 'band-gap')

    expect(gaps).toHaveLength(1)
    expect(gaps[0]!.detail).toContain('6–8')
  })

  it('упорядочивает диапазоны по нижней границе, как бы они ни лежали в источнике', () => {
    const terms = [{ MIN: 8, MAX: 10, TEXT: 'б' }, { MIN: 4, MAX: 8, TEXT: 'а' }]

    const bands = readLegacyTemplates(withTerms(terms)).templates[0]!.sections[0]!.bands

    expect(bands.map(b => b.from)).toEqual([4, 8])
  })
})
