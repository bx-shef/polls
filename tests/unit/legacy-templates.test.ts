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
    expect(warnings.filter(w => w.code === 'template-unreadable')).toHaveLength(1)
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

  const gapsOf = (terms: unknown) =>
    readLegacyTemplates(withTerms(terms)).warnings.filter(w => w.code === 'band-gap').map(w => w.detail)

  /** Диапазоны, покрывающие шкалу 0–10 целиком: фон, на котором видно ровно проверяемую дыру. */
  const FULL = [{ MIN: 0, MAX: 6, TEXT: 'а' }, { MIN: 6, MAX: 10, TEXT: 'б' }]

  it('вычищает HTML до текста и говорит об этом', () => {
    const terms = [{ MIN: '0', MAX: '10', TEXT: '<p class="g-color-white">Где-то мы <b>свернули</b> не туда</p>' }]

    const { templates, warnings } = readLegacyTemplates(withTerms(terms))

    expect(templates[0]!.sections[0]!.bands[0]).toEqual({ from: 0, to: 10, text: 'Где-то мы свернули не туда' })
    expect(warnings.filter(w => w.code === 'html-stripped')).toHaveLength(1)
  })

  it('не считает дырой смежные границы', () => {
    // В источнике диапазоны стыкуются: 0–7.5, затем 7.5–10. Это не разрыв.
    expect(gapsOf([{ MIN: 0, MAX: 7.5, TEXT: 'а' }, { MIN: 7.5, MAX: 10, TEXT: 'б' }])).toEqual([])
  })

  it('не находит дыр там, где шкала покрыта целиком', () => {
    expect(gapsOf(FULL)).toEqual([])
  })

  it('сообщает о разрыве между диапазонами', () => {
    expect(gapsOf([{ MIN: 0, MAX: 4, TEXT: 'а' }, { MIN: 8, MAX: 10, TEXT: 'б' }])).toEqual([
      'шкала не покрыта на отрезке 4–8',
    ])
  })

  it('ловит дыру внизу шкалы — ту самую, ради которой всё писалось', () => {
    // Гвард от дефекта, найденного панелью ревью PR #14. Сравнивались только соседние пары,
    // и случай анкеты digital не ловился: диапазоны шли с 4 и стыковались вплотную, а отрезок
    // 0–4 не покрывал никто. Клиент с плохой оценкой не видел текста, а отчёт о переносе
    // сказал бы «дыр нет» — молчаливее дефекта не бывает.
    const digital = [
      { MIN: 4, MAX: 6, TEXT: 'Где-то мы свернули не туда' },
      { MIN: 6, MAX: 7.5, TEXT: 'б' },
      { MIN: 7.5, MAX: 8, TEXT: 'в' },
      { MIN: 8, MAX: 8.5, TEXT: 'г' },
      { MIN: 8.5, MAX: 9.4, TEXT: 'д' },
      { MIN: 9.4, MAX: 10, TEXT: 'Мы на вершине!' },
    ]

    expect(gapsOf(digital)).toEqual(['шкала не покрыта на отрезке 0–4'])
  })

  it('ловит дыру вверху шкалы', () => {
    expect(gapsOf([{ MIN: 0, MAX: 8, TEXT: 'а' }])).toEqual(['шкала не покрыта на отрезке 8–10'])
  })

  it('упорядочивает диапазоны по нижней границе, как бы они ни лежали в источнике', () => {
    const bands = readLegacyTemplates(withTerms([...FULL].reverse())).templates[0]!.sections[0]!.bands

    expect(bands.map(b => b.from)).toEqual([0, 6])
  })

  it('молчит про края, когда шкалу взять неоткуда', () => {
    // Секция без балльных вопросов: сравнивать не с чем, и выдумывать шкалу мы не станем.
    const options = [{
      name: 'questionary_group_digital',
      value: JSON.stringify([{ NAME: 'Вопросы', FIELD: '', TERMS: [{ MIN: 4, MAX: 6, TEXT: 'а' }], FIELDS: [
        { CODE: 'UF_HQ_D_9', NAME: '', TYPE: 'TEXT' },
      ] }]),
    }]

    expect(readLegacyTemplates(options).warnings.filter(w => w.code === 'band-gap')).toEqual([])
  })
})

/**
 * Гварды под то, что подтвердил НАСТОЯЩИЙ снимок заказчика.
 *
 * ⚠ Эти три вещи разбор угадывал, и в коде рядом честно стояло «имя ключа НЕ подтверждено».
 * Снимок пришёл — и все три догадки оказались неверными. Формы ниже взяты из него дословно.
 */
describe('формы, подтверждённые настоящим снимком', () => {
  const digitalTerms = (terms: unknown[]) => [{
    name: 'questionary_group_digital',
    value: JSON.stringify([{
      NAME: 'Процессы',
      FIELD: 'PROPERTY_PROCESS',
      TERMS: terms,
      FIELDS: [{ CODE: 'UF_A', NAME: '', TYPE: 'POINT', SETTING: { MIN: '0', MAX: '10', SIZE: '100' } }],
    }]),
  }]

  it('текст диапазона лежит под ключом `VALUE`, а не `TEXT`', () => {
    // ⚠ Главный гвард файла. Разбор брал `TEXT`/`NAME` — у всех шести диапазонов `digital`
    // текст выходил ПУСТОЙ строкой, и предупреждение `html-stripped` не срабатывало, потому
    // что `looksLikeHtml('')` — ложь. То есть «клиент с плохой оценкой не увидит ничего» —
    // инвариант, ради которого диапазоны и переносятся, — нарушался бы молча.
    const { templates } = readLegacyTemplates(digitalTerms([
      { MIN: '4', MAX: '6', VALUE: '<div class="g-color-white text-center">Где-то мы свернули не туда</div>' },
    ]))

    expect(templates[0]!.sections[0]!.bands[0]!.text).toBe('Где-то мы свернули не туда')
  })

  it('`MAX: "0"` в последнем диапазоне читается как «до верха шкалы» — и это в отчёте', () => {
    // ⚠ Так в источнике БУКВАЛЬНО: `{"MIN":"9.4","MAX":"0"}`. Диапазон «от 9,4 до 0»
    // не совпадёт ни с чем, то есть верхняя оценка осталась бы без текста. Догадка о чужих
    // данных не проходит молча, даже верная.
    const { templates, warnings } = readLegacyTemplates(digitalTerms([
      { MIN: '9.4', MAX: '0', VALUE: 'Мы на вершине!' },
    ]))

    expect(templates[0]!.sections[0]!.bands[0]).toMatchObject({ from: 9.4, to: 10 })
    expect(warnings.some(w => w.code === 'band-open-end')).toBe(true)
  })

  it('хвостовой `\\r` из формулировки обрезается', () => {
    // В снимке подписи приезжают как «качество аналитики\r» — источник в MySQL с виндовыми
    // переводами строк. Невидимый символ уехал бы в анкету, которую читает посторонний.
    const { templates } = readLegacyTemplates(
      digitalTerms([]),
      [{ template: 'digital', field: 'UF_A', title: 'качество аналитики\r' }],
    )

    expect(templates[0]!.sections[0]!.questions[0]!.title).toBe('качество аналитики')
  })
})

describe('предупреждения о составе секции', () => {
  const section = (fields: unknown[], name = 'Продукт', field = 'PROPERTY_PRODUCT') => [{
    name: 'questionary_group_synthetic',
    value: JSON.stringify([{ NAME: name, FIELD: field, FIELDS: fields }]),
  }]

  const point = (code: string, size: number) =>
    ({ CODE: code, NAME: '', TYPE: 'POINT', SETTING: { MIN: 0, MAX: 10, SIZE: size } })

  it('сообщает, когда сумма весов не 100', () => {
    // Гвард из мутационного прогона на ревью PR #14: код предупреждения существовал,
    // но ни один тест не проверял, что он вообще срабатывает.
    const warnings = readLegacyTemplates(section([point('A', 30), point('B', 30)])).warnings

    expect(warnings.filter(w => w.code === 'weights-not-100').map(w => w.detail)).toEqual(['сумма весов 60, а не 100'])
  })

  it('сообщает, когда в оценочной секции нечего оценивать', () => {
    // Все вопросы выключены весом 0: секция объявлена балльной, а балла не даёт.
    const warnings = readLegacyTemplates(section([point('A', 0)])).warnings

    expect(warnings.filter(w => w.code === 'section-not-scored').map(w => w.at)).toEqual(['product'])
  })

  it('не проверяет весов у секции открытых вопросов', () => {
    // Иначе предупреждение навесится на каждую анкету: там текстовые вопросы и весов нет.
    const warnings = readLegacyTemplates(
      section([{ CODE: 'A', NAME: '', TYPE: 'TEXT' }], 'Вопросы', ''),
    ).warnings

    expect(warnings.filter(w => w.code === 'weights-not-100' || w.code === 'section-not-scored')).toEqual([])
  })
})

describe('подписи полей', () => {
  it('находятся независимо от регистра', () => {
    // Гвард из мутационного прогона на ревью PR #14. Подписи приезжают выгрузкой из MySQL,
    // где разнобой регистра обычное дело, а промах по индексу ничего не ломает — он тихо
    // оставляет заголовок пустым, и заметить это можно только на настоящем снимке.
    const labels = [{ template: 'BRAND', field: 'uf_hq_prod_analyt', title: 'Аналитика продукта' }]

    const { templates } = readLegacyTemplates(
      realOptions().filter(o => o.name === 'questionary_group_brand'),
      labels,
    )

    expect(templates[0]!.sections[0]!.questions[0]!.title).toBe('Аналитика продукта')
  })
})

describe('столкновение ключей внутри одной секции', () => {
  it('разводит одинаковые коды в одной секции, а не выдаёт им общий ключ', () => {
    // В одиннадцати разобранных анкетах такого нет, но digital мы не видели. Суффикса
    // по секции здесь мало: оба вхождения получили бы один ключ, и уникальность,
    // ради которой расщепление и существует, не наступила бы.
    const options = [{
      name: 'questionary_group_synthetic',
      value: JSON.stringify([{ NAME: 'Продукт', FIELD: 'PROPERTY_PRODUCT', FIELDS: [
        { CODE: 'UF_DUP', NAME: '', TYPE: 'POINT', SETTING: { MIN: 0, MAX: 10, SIZE: 50 } },
        { CODE: 'UF_DUP', NAME: '', TYPE: 'POINT', SETTING: { MIN: 0, MAX: 10, SIZE: 50 } },
      ] }]),
    }]

    const questions = readLegacyTemplates(options).templates[0]!.sections[0]!.questions

    expect(questions.map(q => q.key)).toEqual(['UF_DUP__product', 'UF_DUP__product_2'])
    expect(new Set(questions.map(q => q.sourceKey))).toEqual(new Set(['UF_DUP']))
  })
})
