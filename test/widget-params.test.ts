import { describe, expect, it } from 'vitest'
import { buildSurveyInviteActivity } from '../src/bitrix24/activity'
import { hasIssuedInvitation, readLinkVerdict, readWidgetParams } from '../src/client/widget-params'

/**
 * Разбор параметров открытия виджета. Цена ошибки здесь конкретная: перепутав два способа открытия,
 * виджет выпишет ВТОРОЕ приглашение на ту же сделку — дубль, сделанный руками менеджера, ровно после
 * того, как мы избавились от машинных (#138).
 */
describe('открытие ИЗ КАРТОЧКИ сделки', () => {
  it('портал кладёт ID строкой — читаем числом', () => {
    expect(readWidgetParams({ ID: '759' })).toEqual({ dealId: 759 })
  })

  it('и числом тоже', () => {
    expect(readWidgetParams({ ID: 759 })).toEqual({ dealId: 759 })
  })

  it('это НЕ открытие по приглашению — токена нет', () => {
    expect(hasIssuedInvitation(readWidgetParams({ ID: '759' }))).toBe(false)
  })
})

describe('открытие КНОПКОЙ из таймлайна', () => {
  const params = { dealId: '759', surveyKey: 'csat_postdeal', token: 'tok-1' }

  it('токен и ключ опроса доезжают', () => {
    expect(readWidgetParams(params)).toEqual({ dealId: 759, surveyKey: 'csat_postdeal', token: 'tok-1' })
  })

  it('распознаётся как «приглашение уже выписано»', () => {
    expect(hasIssuedInvitation(readWidgetParams(params))).toBe(true)
  })

  it('ВЕРХНИЙ регистр ключей тоже читается', () => {
    // Bitrix24 именует ключи по-разному в разных плейсментах; строгий разбор дал бы «кнопка молча
    // не работает», а понять это по симптому было бы нечем.
    expect(readWidgetParams({ DEAL_ID: '759', SURVEY_KEY: 'k', TOKEN: 't' }))
      .toEqual({ dealId: 759, surveyKey: 'k', token: 't' })
  })
})

describe('мусор и половина параметров', () => {
  it('не-объект → пусто, без падения', () => {
    for (const raw of [undefined, null, 'строка', 42, []]) {
      expect(readWidgetParams(raw)).toEqual({})
    }
  })

  it('негодный ID → сделки нет (а не 0 и не NaN)', () => {
    for (const bad of ['', '  ', 'abc', '0', '-5', '1.5', null]) {
      expect(readWidgetParams({ ID: bad }).dealId, String(bad)).toBeUndefined()
    }
  })

  it('пустые строки не считаются значением', () => {
    expect(readWidgetParams({ ID: '759', surveyKey: '  ', token: '' })).toEqual({ dealId: 759 })
  })

  it('ПОЛОВИНА параметров → ведём себя как при обычном открытии', () => {
    // Сбой проводки кнопки. Показать пустоту молча — худший вариант: менеджер решит, что сломался
    // сам опрос. Создать ссылку — рабочее поведение, пусть и не то, которого он ждал.
    expect(hasIssuedInvitation(readWidgetParams({ dealId: '759', token: 'tok-1' }))).toBe(false)
    expect(hasIssuedInvitation(readWidgetParams({ dealId: '759', surveyKey: 'k' }))).toBe(false)
  })

  it('окружающие пробелы срезаются', () => {
    expect(readWidgetParams({ ID: ' 759 ', token: ' tok-1 ' })).toMatchObject({ dealId: 759, token: 'tok-1' })
  })
})

describe('проводка кнопки: дело пишет — виджет читает', () => {
  it('actionParams РЕАЛЬНОГО дела распознаются как «приглашение уже выписано»', () => {
    // Гард от расхождения имён. Дело и виджет — разные слои, TypeScript их не связывает: переименуй
    // параметр в одном месте, и сборка с тестами останутся зелёными, а кнопка тихо начнёт выписывать
    // ВТОРОЕ приглашение. Поэтому тут прогоняем НАСТОЯЩИЙ билдер дела через НАСТОЯЩИЙ разбор виджета.
    const activity = buildSurveyInviteActivity({
      dealId: 759,
      surveyTitle: 'Опрос после сделки',
      surveyKey: 'csat_postdeal',
      token: 'tok-1',
      surveyUrl: 'https://polls.example/s/csat_postdeal?token=tok-1'
    })
    const button = activity.layout.footer.buttons.sendInvite as {
      action: { actionParams: Record<string, unknown> }
    }
    const params = readWidgetParams(button.action.actionParams)
    expect(hasIssuedInvitation(params)).toBe(true)
    expect(params).toEqual({ dealId: 759, surveyKey: 'csat_postdeal', token: 'tok-1' })
  })
})

describe('годность УЖЕ выписанной ссылки (кнопка на старом деле)', () => {
  it('сервер сказал «годна» → показываем ссылку', () => {
    expect(readLinkVerdict(200, { ok: true })).toEqual({ alive: true })
  })

  it('явный отказ → ссылка мёртвая, причину показываем как есть', () => {
    // Текст сервера уже написан для человека («Срок ссылки истёк…») — своего не сочиняем.
    expect(readLinkVerdict(403, { ok: false, error: 'Срок ссылки истёк, или опрос по ней уже пройден.' }))
      .toEqual({ alive: false, reason: 'Срок ссылки истёк, или опрос по ней уже пройден.' })
  })

  it('отказ без текста → мёртвая, но без выдуманной причины', () => {
    expect(readLinkVerdict(400, { ok: false })).toEqual({ alive: false })
  })

  it('429 и 5xx — НЕ вердикт о ссылке (fail-open)', () => {
    // Посчитав сбой проверки отказом, мы заставили бы сотрудника выписать вторую ссылку на живое
    // приглашение — то есть сами породили бы дубль ровно там, где от него защищаемся.
    for (const status of [429, 500, 502, 503]) {
      expect(readLinkVerdict(status, { ok: false, error: 'Слишком много запросов.' }), String(status))
        .toEqual({ alive: true })
    }
  })

  it('мусор вместо тела → мёртвая без причины, без падения', () => {
    for (const body of [undefined, null, 'строка', 42]) {
      expect(readLinkVerdict(403, body)).toEqual({ alive: false })
    }
  })
})
