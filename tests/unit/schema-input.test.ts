import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  MAX_SCHEMA_BYTES,
  MAX_STRING_BYTES,
  assignMissingKeys,
  newQuestionKey,
  newSectionKey,
  readIncomingSchema,
} from '../../server/domain/templates/schema-input'
import { buildSaveSchemaCall } from '../../server/domain/templates/portal-calls'

/**
 * Граница доверия конструктора: что мы готовы принять из браузера.
 *
 * ⚠ Это НЕ проверка формы. Схема приезжает из браузера сотрудника, ложится в смарт-процесс
 * клиента и оттуда попадает на ПУБЛИЧНУЮ страницу, которую открывает посторонний человек.
 * Всё, что сюда пустят, он увидит. Поэтому объект собирается заново поле за полем, и тесты
 * проверяют именно это: не «отвергли плохое», а «перенесли только своё».
 */

/** Минимально годная схема — с неё начинается каждый тест. */
const schema = () => ({
  code: 'brand',
  title: 'Бренд-платформа',
  sections: [{
    key: 'product',
    title: 'Продукт',
    scored: true,
    questions: [{ key: 'P1', sourceKey: 'P1', title: 'Удобно?', type: 'scale', weight: 1, scored: true, scale: { min: 0, max: 10 } }],
    bands: [{ from: 0, to: 10, text: 'Норм' }],
  }],
})

/** Разобранная схема или провал теста: у отказа другая форма, и путать их нельзя. */
function taken(raw: unknown) {
  const result = readIncomingSchema(raw)
  if ('refusal' in result) throw new Error(`схема не принята: ${result.refusal}`)
  return result
}

describe('что переносится, а что нет', () => {
  it('ГЛАВНОЕ: чужие поля не переносятся вовсе', () => {
    // ⚠ Не «отбрасываются по списку запрещённого» — такой список устаревает, а список
    // разрешённого нет. Проверяем на том, что заметно: поле с исполняемым именем рядом
    // с настоящими. Оно попало бы в JSON смарт-процесса и уехало бы на публичную страницу.
    const dirty = schema() as Record<string, unknown>
    dirty.onclick = 'alert(1)'
    dirty.sections = [{ ...schema().sections[0], onerror: 'x', __hack: { deep: true } }]

    const result = taken(dirty)

    expect(Object.keys(result).sort()).toEqual(['code', 'sections', 'title'])
    expect(Object.keys(result.sections[0]!).sort()).toEqual(['bands', 'key', 'questions', 'scored', 'title'])
    expect(JSON.stringify(result)).not.toContain('alert')
  })

  it('ключи вопроса и раздела НЕ подставляются молча', () => {
    // ⚠ Пустой ключ — законное состояние недособранного черновика, и о нём скажет проверка
    // смысла. Подставив новый тихо, мы получили бы раздел, ключ которого меняется сам
    // по себе между сохранениями, — то есть баллы, которые перестают сходиться.
    const empty = schema()
    empty.sections[0]!.key = ''
    empty.sections[0]!.questions[0]!.key = ''

    const result = taken(empty)

    expect(result.sections[0]!.key).toBe('')
    expect(result.sections[0]!.questions[0]!.key).toBe('')
  })

  it('тип вопроса — только из списка', () => {
    const odd = schema()
    // Тип не из перечисления — ровно то, что браузер прислать может, а мы принять не должны.
    odd.sections[0]!.questions[0]!.type = 'html'

    expect(taken(odd).sections[0]!.questions[0]!.type).toBe('text')
  })

  it('шкала переносится ТОЛЬКО у балльного вопроса', () => {
    // У текстового она ничего не значит, а в схеме выглядела бы настройкой, которая
    // почему-то не работает.
    const odd = schema()
    // Тип меняем, шкалу оставляем — так выглядит форма, в которой переключили вид вопроса.
    odd.sections[0]!.questions[0]!.type = 'text'

    expect(taken(odd).sections[0]!.questions[0]).not.toHaveProperty('scale')
  })

  it('ГЛАВНОЕ: пустое поле шкалы — это НЕ ноль', () => {
    // ⚠ Та самая ловушка, на которой проект уже горел: `Number('')` даёт `0`, ровно как
    // `Number(null)`, — и незаполненное число превращалось в честный «балл 0» у анкеты,
    // которую никто не проходил. Здесь источник тот же по природе: пустое поле формы
    // приезжает пустой строкой, и шкала `0–0` выглядела бы выбором автора.
    //
    // Первая редакция этой границы сравнивала `Number.isFinite` и пропускала пустую строку.
    // Поймал этот самый тест.
    for (const empty of [{ min: '', max: '' }, { min: '  ', max: 10 }, { min: null, max: 10 }, {}]) {
      const odd = schema()
      // @ts-expect-error — так выглядит наполовину заполненная форма.
      odd.sections[0]!.questions[0]!.scale = empty
      expect(taken(odd).sections[0]!.questions[0], JSON.stringify(empty)).not.toHaveProperty('scale')
    }

    // А настоящий ноль остаётся нулём: шкала `0–10` — самая обычная.
    const real = schema()
    real.sections[0]!.questions[0]!.scale = { min: 0, max: 10 }
    expect(taken(real).sections[0]!.questions[0]!.scale).toEqual({ min: 0, max: 10 })
  })

  it('пустой вес — не ноль, а единица по умолчанию', () => {
    // Ноль у вопроса, идущего в оценку, означает «не влияет на балл», и подставить его
    // за автора значило бы выключить вопрос, который он включал.
    const odd = schema()
    // @ts-expect-error — пустое поле формы.
    odd.sections[0]!.questions[0]!.weight = ''

    expect(taken(odd).sections[0]!.questions[0]!.weight).toBe(1)
  })

  it('`sourceKey` у собранного в конструкторе совпадает с ключом', () => {
    // Источника у него нет, и выдумывать его нельзя: расщепление одного поля на два вопроса
    // бывает только при переносе.
    const fresh = schema()
    // @ts-expect-error — конструктор `sourceKey` не шлёт вовсе.
    delete fresh.sections[0]!.questions[0]!.sourceKey

    const question = taken(fresh).sections[0]!.questions[0]!
    expect(question.sourceKey).toBe(question.key)
  })
})

describe('размеры', () => {
  it('ГЛАВНОЕ: строка режется по БАЙТАМ, а не по символам', () => {
    // ⚠ Правило проекта. Кириллица весит вдвое, и предел в символах пропустил бы вдвое
    // больше, чем обещает, — то есть защищал бы ровно вдвое хуже на нашем языке.
    const long = schema()
    long.sections[0]!.questions[0]!.title = 'я'.repeat(MAX_STRING_BYTES)

    const title = taken(long).sections[0]!.questions[0]!.title
    expect(Buffer.byteLength(title, 'utf8')).toBeLessThanOrEqual(MAX_STRING_BYTES)
    expect(title.length).toBeLessThan(MAX_STRING_BYTES)
  })

  it('режет по кодовым точкам: оборванного символа не остаётся', () => {
    const long = schema()
    long.sections[0]!.title = '😀'.repeat(MAX_STRING_BYTES)

    const title = taken(long).sections[0]!.title
    expect(title).not.toContain('�')
    expect([...title].every(point => point === '😀')).toBe(true)
  })

  it('схема целиком больше предела — отказ, и до разбора', () => {
    // ⚠ Разбирать мегабайт, чтобы потом отказать, — это и есть способ положить обработку
    // у всех порталов разом: Node однопоточный.
    const huge = schema()
    huge.sections[0]!.questions[0]!.title = 'x'.repeat(MAX_SCHEMA_BYTES + 1)

    expect(readIncomingSchema(huge)).toEqual({ refusal: 'too-big' })
  })

  it('слишком много вопросов — отказ', () => {
    const many = schema()
    many.sections[0]!.questions = Array.from({ length: 100 }, (_, i) => ({
      ...schema().sections[0]!.questions[0]!,
      key: `q${i}`,
    }))

    expect(readIncomingSchema(many)).toEqual({ refusal: 'too-many' })
  })

  it('не объект — отказ, а не пустая схема', () => {
    // Пустая схема прошла бы дальше и перезаписала бы черновик ничем.
    for (const junk of [null, 'схема', 42, [], undefined]) {
      expect(readIncomingSchema(junk)).toEqual({ refusal: 'not-object' })
    }
  })
})

describe('управляющие символы', () => {
  it('выбрасываются, а перевод строки остаётся', () => {
    // ⚠ В формулировке вопроса управляющим символам взяться неоткуда, а сломать они могут
    // и JSON в поле портала, и показ на публичной странице. Перевод строки в тексте
    // диапазона осмыслен, поэтому он живёт.
    const dirty = schema()
    dirty.sections[0]!.questions[0]!.title = 'Уд\u0000об\u0007но?'
    dirty.sections[0]!.bands[0]!.text = 'Первая\nвторая'

    const result = taken(dirty)
    expect(result.sections[0]!.questions[0]!.title).toBe('Удобно?')
    expect(result.sections[0]!.bands[0]!.text).toBe('Первая\nвторая')
  })
})

describe('новые ключи', () => {
  it('ГЛАВНОЕ: два подряд не совпадают', () => {
    // ⚠ Инвариант: ключи не переиспользуются после удаления. Счётчик «максимум плюс один»
    // выдал бы удалённый ключ заново, и ответы прошлых версий начали бы складываться
    // с новыми. Случайность делает переиспользование невозможным по построению.
    const keys = new Set(Array.from({ length: 200 }, () => newQuestionKey()))

    expect(keys.size).toBe(200)
  })

  it('годятся как ключ: латиница и цифры, не пустые', () => {
    expect(newQuestionKey()).toMatch(/^q[a-f0-9]{10}$/)
    expect(newSectionKey()).toMatch(/^s[a-f0-9]{10}$/)
  })
})

describe('раздача ключей', () => {
  it('ГЛАВНОЕ: существующие ключи НЕ переписываются', () => {
    // ⚠ Инвариант: ключи стабильны. Переписав их при сохранении, мы оторвали бы уже
    // собранные ответы от их вопросов — молча и необратимо. Проверяется именно это,
    // а не «новым ключ выдали»: вторая половина видна, первая нет.
    const keyed = assignMissingKeys({
      code: 'brand',
      title: 'Бренд',
      sections: [{
        key: 'product',
        title: 'Продукт',
        scored: true,
        questions: [{ key: 'P1', sourceKey: 'SRC', title: 'A', type: 'scale', weight: 1, scored: true }],
        bands: [],
      }],
    })

    expect(keyed.sections[0]!.key).toBe('product')
    expect(keyed.sections[0]!.questions[0]!.key).toBe('P1')
    expect(keyed.sections[0]!.questions[0]!.sourceKey).toBe('SRC')
  })

  it('пустым выдаёт новые, и двум подряд — разные', () => {
    // Добавленный во вкладке вопрос приходит без ключа: браузер выдать его не может —
    // генератор живёт в домене, а `app/` в серверные модули не ходит.
    const keyed = assignMissingKeys({
      code: 'brand',
      title: 'Бренд',
      sections: [{
        key: '',
        title: '',
        scored: false,
        questions: [
          { key: '', sourceKey: '', title: 'A', type: 'text', weight: 1, scored: false },
          { key: '', sourceKey: '', title: 'Б', type: 'text', weight: 1, scored: false },
        ],
        bands: [],
      }],
    })

    const [first, second] = keyed.sections[0]!.questions
    expect(keyed.sections[0]!.key).not.toBe('')
    expect(first!.key).not.toBe(second!.key)
    // `sourceKey` идёт следом за ключом: источника у собранного в конструкторе нет.
    expect(first!.sourceKey).toBe(first!.key)
  })
})

describe('запись схемы в портал', () => {
  it('схема уезжает СТРОКОЙ, и вместе с ней название карточки', () => {
    // ⚠ Поле текстовое, и читаем мы его обратно тоже из строки. Отдав объект, мы положились
    // бы на то, что портал сериализует его так же, как мы ожидаем прочесть.
    //
    // ⚠ Название карточки пишется тем же вызовом: в списке смарт-процесса человек видит
    // заголовок, а в ссылке респондента — название из схемы, и разойтись им нельзя.
    const call = buildSaveSchemaCall({ entityTypeId: 1038, id: 8 }, 42, {
      code: 'brand',
      title: 'Бренд-платформа',
      sections: [],
    })

    expect(call.method).toBe('crm.item.update')
    const params = call.params as Record<string, unknown>
    expect(params).toMatchObject({ entityTypeId: 1038, id: 42, useOriginalUfNames: 'Y' })
    const fields = params.fields as Record<string, unknown>
    expect(fields.title).toBe('Бренд-платформа')
    expect(fields.UF_CRM_8_CODE).toBe('brand')
    expect(typeof fields.UF_CRM_8_SCHEMA).toBe('string')
    expect(JSON.parse(fields.UF_CRM_8_SCHEMA as string)).toMatchObject({ code: 'brand' })
  })
})
