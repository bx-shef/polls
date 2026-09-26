import { describe, expect, it } from 'vitest'
import { findScaleGaps, sectionScale, validateTemplate } from '../../server/domain/surveys/validate'
import type { SurveySection, SurveyTemplate } from '../../server/domain/surveys/model'

/**
 * Проверка схемы анкеты перед публикацией.
 *
 * ⚠ Эта проверка — единственное, что стоит между автором анкеты и инвариантами проекта.
 * Опубликованная версия неизменяема: ошибку, уехавшую в публикацию, нельзя починить, можно
 * только выпустить новую версию, — а ссылки, уже отправленные людям, останутся на старой.
 * Поэтому каждая претензия здесь названа по дефекту, а не «на всякий случай».
 *
 * ⚠ Проверка покрытия шкалы ОБЩАЯ с адаптером импорта: она там и оплачена живыми данными.
 * Тесты на неё есть в обоих местах намеренно — здесь про конструктор, там про перенос,
 * и сломать надо обе, чтобы дыра уехала клиенту.
 */

/** Здоровая анкета: с неё начинается каждый тест, портим по одному месту. */
function healthy(): SurveyTemplate {
  return {
    code: 'brand',
    title: 'Бренд-платформа',
    sections: [{
      key: 'product',
      title: 'Продукт',
      scored: true,
      questions: [
        { key: 'P1', sourceKey: 'P1', title: 'Насколько удобно?', type: 'scale', weight: 1, scored: true, scale: { min: 0, max: 10 } },
        { key: 'T1', sourceKey: 'T1', title: 'Что улучшить?', type: 'text', weight: 0, scored: false },
      ],
      bands: [
        { from: 0, to: 6, text: 'Плохо' },
        { from: 6, to: 10, text: 'Хорошо' },
      ],
    }],
  }
}

/** Все претензии одной строкой — читать проще, чем перебирать массив. */
const said = (schema: SurveyTemplate) => validateTemplate(schema).map(p => `${p.where}: ${p.message}`).join(' | ')
const errors = (schema: SurveyTemplate) => validateTemplate(schema).filter(p => p.level === 'error')

describe('здоровая анкета', () => {
  it('не вызывает ни одной претензии', () => {
    // ⚠ Без этого теста любая проверка ниже могла бы быть написана «всегда ругается»,
    // и все остальные прошли бы зелёными.
    expect(validateTemplate(healthy())).toEqual([])
  })
})

describe('покрытие шкалы диапазонами', () => {
  it('ГЛАВНОЕ: дыра в середине не даёт опубликовать', () => {
    // ⚠ Инвариант проекта, и цена названа в нём же: клиент с плохой оценкой не увидит ничего.
    // В старом решении это срабатывало в 100 % проверяемых случаев.
    const schema = healthy()
    schema.sections[0]!.bands = [{ from: 0, to: 4, text: 'Плохо' }, { from: 7, to: 10, text: 'Хорошо' }]

    expect(said(schema)).toContain('не покрыта на отрезке 4–7')
  })

  it('ГЛАВНОЕ: нижний край шкалы проверяется отдельно', () => {
    // ⚠ Тот самый дефект из PR #14. У анкеты `digital` диапазоны шли с четвёрки и между собой
    // стыковались вплотную — сравнение только соседних пар говорило «дыр нет», а непокрытым
    // оставался весь отрезок 0–4, то есть ровно плохие оценки.
    const schema = healthy()
    schema.sections[0]!.bands = [{ from: 4, to: 7, text: 'Так себе' }, { from: 7, to: 10, text: 'Хорошо' }]

    expect(said(schema)).toContain('не покрыта на отрезке 0–4')
  })

  it('верхний край тоже', () => {
    const schema = healthy()
    schema.sections[0]!.bands = [{ from: 0, to: 8, text: 'Нормально' }]

    expect(said(schema)).toContain('не покрыта на отрезке 8–10')
  })

  it('смыкание вплотную дырой НЕ считается', () => {
    // ⚠ Границы включительные с обеих сторон, соседние диапазоны смежные (…6–7.5, 7.5–8…),
    // на стыке побеждает первый. Проверка обязана рассуждать так же, как `findBand`, иначе
    // она ругается на здоровые анкеты — и её начинают игнорировать.
    expect(validateTemplate(healthy())).toEqual([])
  })

  it('у балльного раздела без диапазонов — ошибка, а не тишина', () => {
    const schema = healthy()
    schema.sections[0]!.bands = []

    expect(said(schema)).toContain('не увидит никакого текста')
  })

  it('перевёрнутый диапазон виден', () => {
    const schema = healthy()
    schema.sections[0]!.bands = [{ from: 10, to: 0, text: 'Всё' }]

    expect(said(schema)).toContain('перевёрнут')
  })

  it('диапазон без текста — ошибка: текст и есть то, что видит отвечающий', () => {
    const schema = healthy()
    schema.sections[0]!.bands[1]!.text = '   '

    expect(said(schema)).toContain('нет текста')
  })

  it('ГЛАВНОЕ: нечисловая граница не прячет дыру', () => {
    // ⚠ Нашёл `/code-review`. `NaN` в границе делает ложными ВСЕ дальнейшие сравнения
    // покрытия, и проверка не ругалась, а ЗАМОЛКАЛА: анкета с дырой уходила в публикацию
    // как здоровая. Худший вид отказа — тот, при котором гейт выглядит пройденным.
    const schema = healthy()
    schema.sections[0]!.bands = [
      { from: 0, to: 4, text: 'Плохо' },
      { from: 7, to: Number.NaN, text: 'Хорошо' },
    ]

    const problems = said(schema)
    expect(problems).toContain('не числа')
    // ⚠ Дыра названа от 4 до 10, а не до 7: испорченный диапазон отброшен целиком, значит
    // покрытие честно кончается там, где кончился последний исправный. Сказать «4–7» значило
    // бы засчитать покрытие диапазону, границ у которого нет.
    expect(problems).toContain('не покрыта на отрезке 4–10')
  })

  it('балльный вопрос без шкалы не выдаётся за «балльных вопросов нет»', () => {
    // ⚠ Тоже находка `/code-review`. `sectionScale` отвечает `null` на две разные беды —
    // «вопросов нет» и «шкала у них не задана», — и проверка их не различала: говорила
    // про раздел с балльными вопросами, что их там нет, а заодно молча пропускала
    // все остальные претензии к диапазонам, потому что выходила раньше.
    const schema = healthy()
    delete schema.sections[0]!.questions[0]!.scale
    schema.sections[0]!.bands = [{ from: 0, to: 6, text: '' }]

    const problems = said(schema)
    expect(problems).toContain('не задана шкала')
    expect(problems).not.toContain('балла у него не будет никогда')
    // Претензия к диапазону НЕ потерялась — ровно то, что прятал ранний выход.
    expect(problems).toContain('нет текста')
  })

  it('мёртвый диапазон — предупреждение, а не ошибка', () => {
    // ⚠ `findBand` берёт ПЕРВЫЙ подходящий, поэтому диапазон, целиком накрытый более ранним,
    // не сработает ни разу. Снаружи это выглядит как «текст почему-то не тот», и причину
    // будут искать в баллах. Публиковать не мешает: анкета рабочая, просто с мусором.
    const schema = healthy()
    schema.sections[0]!.bands = [
      { from: 0, to: 10, text: 'Что угодно' },
      { from: 3, to: 5, text: 'Этот не сработает' },
    ]
    const problems = validateTemplate(schema)

    expect(problems).toHaveLength(1)
    expect(problems[0]!.level).toBe('warning')
    expect(problems[0]!.message).toContain('не сработает никогда')
  })
})

describe('ключи', () => {
  it('ГЛАВНОЕ: один ключ на два вопроса — один ответ повлияет на два балла', () => {
    // ⚠ Инвариант проекта, и это уже случалось в старом решении. Ключ уникален В ПРЕДЕЛАХ
    // ВЕРСИИ, а не раздела: по нему ответ находит свой вопрос при пересчёте.
    const schema = healthy()
    schema.sections.push({
      key: 'process',
      title: 'Процесс',
      scored: false,
      questions: [{ key: 'P1', sourceKey: 'P1', title: 'Как шло?', type: 'text', weight: 0, scored: false }],
      bands: [],
    } satisfies SurveySection)

    expect(said(schema)).toContain('уже занят вопросом в разделе «Продукт»')
  })

  it('повтор ключа раздела виден', () => {
    const schema = healthy()
    schema.sections.push({ ...healthy().sections[0]!, questions: [], bands: [] })

    expect(said(schema)).toContain('Ключ раздела «product» уже занят')
  })

  it('пустой ключ вопроса не маскируется под повтор', () => {
    // Два вопроса с пустым ключом — это две отдельные претензии «пустой ключ», а не одна
    // про повтор: иначе автор чинил бы не то.
    const schema = healthy()
    schema.sections[0]!.questions[0]!.key = ''
    schema.sections[0]!.questions[1]!.key = ''

    expect(errors(schema).filter(p => p.message.includes('пустой ключ'))).toHaveLength(2)
    expect(said(schema)).not.toContain('уже занят')
  })
})

describe('вопросы', () => {
  it('ГЛАВНОЕ: текстовый вопрос «в оценке» — молчаливый ноль', () => {
    // ⚠ Тип и метрика — независимые оси по инварианту, но балл считается ТОЛЬКО по балльным
    // вопросам: `scoreSection` отбирает `scored && type === 'scale'`. Значит галочка «идёт
    // в оценку» на текстовом вопросе не делает НИЧЕГО, а автор уверен в обратном.
    const schema = healthy()
    schema.sections[0]!.questions[1]!.scored = true

    expect(said(schema)).toContain('балла не даёт')
  })

  it('балльный вопрос без шкалы', () => {
    const schema = healthy()
    delete schema.sections[0]!.questions[0]!.scale

    expect(said(schema)).toContain('не задана шкала')
  })

  it('шкала наизнанку', () => {
    const schema = healthy()
    schema.sections[0]!.questions[0]!.scale = { min: 10, max: 0 }

    expect(said(schema)).toContain('не имеет смысла')
  })

  it('нулевой вес у оценочного вопроса', () => {
    // В старом источнике выключение выражалось весом 0 — неотличимо от опечатки. У нас
    // для этого есть флаг, поэтому вес 0 при включённой оценке означает именно опечатку.
    const schema = healthy()
    schema.sections[0]!.questions[0]!.weight = 0

    expect(said(schema)).toContain('не повлияет на балл вовсе')
  })

  it('вопрос без формулировки', () => {
    const schema = healthy()
    schema.sections[0]!.questions[0]!.title = '  '

    expect(said(schema)).toContain('нет формулировки')
  })
})

describe('разделы и анкета целиком', () => {
  it('балльный раздел без балльных вопросов не получит балла никогда', () => {
    const schema = healthy()
    schema.sections[0]!.questions[0]!.scored = false
    schema.sections[0]!.bands = []

    expect(said(schema)).toContain('балла у него не будет никогда')
  })

  it('диапазоны у небалльного раздела — предупреждение', () => {
    const schema = healthy()
    schema.sections[0]!.scored = false
    schema.sections[0]!.questions[0]!.scored = false

    const problems = validateTemplate(schema)
    expect(problems).toHaveLength(1)
    expect(problems[0]!.level).toBe('warning')
    expect(problems[0]!.message).toContain('никто никогда не увидит')
  })

  it('пустой раздел', () => {
    const schema = healthy()
    schema.sections[0]!.questions = []
    schema.sections[0]!.bands = []

    expect(said(schema)).toContain('нет ни одного вопроса')
  })

  it('код анкеты — латиница, потому что по нему живут ссылки и статистика', () => {
    for (const code of ['', 'Бренд', 'brand code', 'BRAND', '-brand']) {
      const schema = { ...healthy(), code }
      expect(said(schema)).toContain('Код анкеты')
    }
    expect(validateTemplate({ ...healthy(), code: 'brand_2026-q1' })).toEqual([])
  })

  it('анкета без названия и без разделов', () => {
    const problems = said({ code: 'brand', title: '', sections: [] })

    expect(problems).toContain('нет названия')
    expect(problems).toContain('нет ни одного раздела')
  })
})

describe('границы возможного балла', () => {
  it('берутся по всем балльным вопросам раздела', () => {
    // ⚠ Балл секции — средневзвешенное по ОТВЕЧЕННЫМ вопросам, поэтому достижимый минимум
    // это наименьший минимум шкал: ответив на один вопрос, респондент получает ровно его
    // значение. Взяв минимум только первого вопроса, мы посчитали бы часть шкалы непокрытой.
    const scale = sectionScale([
      { key: 'A', sourceKey: 'A', title: 'A', type: 'scale', weight: 1, scored: true, scale: { min: 1, max: 5 } },
      { key: 'B', sourceKey: 'B', title: 'B', type: 'scale', weight: 1, scored: true, scale: { min: 0, max: 10 } },
    ])

    expect(scale).toEqual({ min: 0, max: 10 })
  })

  it('без балльных вопросов — null, и о покрытии говорить нечего', () => {
    expect(sectionScale([])).toBeNull()
    expect(findScaleGaps([{ from: 3, to: 4, text: 'x' }], null)).toEqual([])
  })

  it('пустой список диапазонов не считается дырой ЗДЕСЬ', () => {
    // Про него ругается `validateTemplate` отдельным и более понятным текстом: «у балльного
    // раздела нет ни одного диапазона». Сообщение «шкала не покрыта на отрезке 0–10»
    // формально верно и бесполезно.
    expect(findScaleGaps([], { min: 0, max: 10 })).toEqual([])
  })
})
