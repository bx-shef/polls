import { describe, expect, it } from 'vitest'
import { readSection, readSnapshot } from '../../server/domain/import/snapshot'

/**
 * Разбор выгрузки из базы старого решения.
 *
 * ⚠ Самое опасное место всего переноса, и до панели ревью оно жило в скрипте — без тестов
 * и без `pnpm typecheck`, потому что `scripts/` не входил ни в один tsconfig. Двое
 * проверяющих указали на это независимо, каждый предполагая СВОЙ вариант разделителя
 * в заголовке: один был уверен, что там таб, другой — что пробел. В настоящей выгрузке
 * заказчика пробел; но само расхождение и есть доказательство, что угадывать нельзя,
 * и поэтому заголовок теперь узнаётся по СОСТАВУ КОЛОНОК.
 *
 * Цена ошибки названа в комментарии самого разбора: «молча не тот кусок» здесь значит
 * запись чужих данных в портал клиента.
 */

const HEADER = 'name value'

describe('поиск результата запроса', () => {
  it('узнаёт заголовок и через пробел, и через табуляцию', () => {
    // ⚠ Главный гвард файла. Консоль MySQL в пакетном режиме разделяет табом, а выгрузка
    // заказчика пришла с пробелами. Привязавшись к одному варианту, мы сказали бы «файл
    // неполный» о полном файле — и перенос не заработал бы вовсе.
    const spaced = readSection(['name value', 'a\t1'], ['name', 'value'])
    const tabbed = readSection(['name\tvalue', 'a\t1'], ['name', 'value'])

    expect(spaced).toEqual([['a', '1']])
    expect(tabbed).toEqual([['a', '1']])
  })

  it('не путает похожий заголовок с нужным', () => {
    // Иначе разбор взял бы соседний результат — и записал бы клиенту чужие данные.
    expect(readSection(['name value extra', 'a\t1'], ['name', 'value'])).toEqual([])
    expect(readSection(['name', 'a\t1'], ['name', 'value'])).toEqual([])
  })

  it('обрезает `\\r` у КАЖДОГО поля, а не только у строки', () => {
    // ⚠ Источник лежит в MySQL с виндовыми переводами строк, и невидимый символ уезжает
    // в последнюю колонку — то есть в формулировку вопроса, которую читает посторонний.
    expect(readSection([`${HEADER}\r`, 'a\t1\r'], ['name', 'value'])).toEqual([['a', '1']])
  })

  it('кончается там, где начинается следующий запрос', () => {
    const rows = readSection([HEADER, 'a\t1', '-- Запрос 2', 'b\t2'], ['name', 'value'])

    expect(rows).toEqual([['a', '1']])
  })

  it('кончается и на новом SELECT, даже с отступом', () => {
    expect(readSection([HEADER, 'a\t1', '  SELECT x', 'b\t2'], ['name', 'value'])).toEqual([['a', '1']])
  })

  it('пустые строки внутри результата не обрывают его', () => {
    // ⚠ Ровно то, чего боится комментарий разбора про «номера съедут»: лишняя пустая строка
    // не должна ни обрывать результат, ни сдвигать его.
    expect(readSection([HEADER, 'a\t1', '', 'b\t2'], ['name', 'value'])).toEqual([['a', '1'], ['b', '2']])
  })

  it('отсутствие результата — пустой список, а не поломка', () => {
    // Судить, можно ли продолжать без этого куска, обязан вызывающий: он знает цену.
    expect(readSection(['совсем другое'], ['name', 'value'])).toEqual([])
  })
})

describe('снимок целиком', () => {
  const FILE = [
    '-- Запрос 1',
    'SELECT NAME AS name, VALUE AS value',
    '',
    'name value',
    'questionary_group_brand\t[{"NAME":"Продукт"}]',
    'questionary_list\t{"CODE":"X"}',
    '',
    '-- Запрос 2',
    'SELECT h.TABLE_NAME AS source_table',
    '',
    'source_table field user_type mandatory multiple sort title',
    'sh_qest_h_brand\tUF_A\tdouble\tN\tN\t100\tкачество аналитики\r',
  ].join('\n')

  it('достаёт настройки и подписи из одного файла', () => {
    const { options, labels } = readSnapshot(FILE)

    expect(options.map(o => o.name)).toEqual(['questionary_group_brand', 'questionary_list'])
    expect(labels).toEqual([{ template: 'brand', field: 'UF_A', title: 'качество аналитики' }])
  })

  it('код анкеты берётся из имени таблицы', () => {
    // `sh_qest_h_<код>` — единственная связь подписи с анкетой, которой она принадлежит.
    expect(readSnapshot(FILE).labels[0]!.template).toBe('brand')
  })

  it('на чужом файле отдаёт пустоту, а не мусор', () => {
    expect(readSnapshot('какой-то другой текст')).toEqual({ options: [], labels: [] })
  })
})
