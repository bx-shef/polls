import { describe, expect, it } from 'vitest'
import { buildSurveyInviteActivity, buildSurveyResultActivity } from '../src/bitrix24/activity'
import {
  hasIssuedInvitation, hasResultRequest, issuedLinkView, readLinkVerdict, readWidgetParams
} from '../src/client/widget-params'

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
    const button = activity.layout.footer!.buttons.sendInvite as {
      action: { actionParams: Record<string, unknown> }
    }
    const params = readWidgetParams(button.action.actionParams)
    expect(hasIssuedInvitation(params)).toBe(true)
    expect(params).toEqual({
      dealId: 759,
      surveyKey: 'csat_postdeal',
      token: 'tok-1',
      url: 'https://polls.example/s/csat_postdeal?token=tok-1'
    })
  })
})

describe('проводка кнопки РЕЗУЛЬТАТА: дело пишет — виджет читает (#18)', () => {
  const built = (over: Record<string, unknown> = {}) => buildSurveyResultActivity({
    dealId: 759,
    surveyTitle: 'Оценка после сделки',
    lines: [{ label: 'Насколько вероятно?', value: '9' }],
    marker: { originatorId: 'bx-shef.polls', originId: 'result:r-42' },
    responseId: 'r-42',
    ...over
  })

  it('actionParams РЕАЛЬНОГО дела распознаются как «показать результат»', () => {
    // Тот же гард, что у приглашения, и с той же ценой: разъедься имена — кнопка откроет виджет без
    // `responseId`, тот примет это за открытие из карточки и предложит выписать НОВОЕ приглашение
    // клиенту, который только что ответил.
    const button = built().layout.footer!.buttons.openResult as {
      action: { type: string; actionParams: Record<string, unknown> }
    }
    expect(button.action.type).toBe('openRestApp')
    const params = readWidgetParams(button.action.actionParams)
    expect(hasResultRequest(params)).toBe(true)
    expect(params).toEqual({ responseId: 'r-42', dealId: 759 })
  })

  it('результат распознаётся РАНЬШЕ приглашения — иначе позовём отвечавшего снова', () => {
    // ⚠️ Дело-результат живёт на той же сделке, что и дело-приглашение, и портал может добавить в
    // options свои ключи. Порядок проверок в виджете решает, что человек увидит.
    const both = readWidgetParams({ responseId: 'r-42', dealId: 759, surveyKey: 'csat', token: 'tk' })
    expect(hasResultRequest(both)).toBe(true)
  })

  it('без responseId кнопки НЕТ вовсе: мёртвая кнопка хуже отсутствующей', () => {
    // До страницы просмотра результата футер отсутствовал ровно поэтому. Сводка в теле дела остаётся
    // в любом случае — ради неё менеджер сюда и смотрит, и от кнопки она зависеть не должна.
    expect(built({ responseId: undefined }).layout.footer).toBeUndefined()
    expect(built({ marker: undefined }).layout.footer).toBeUndefined()
    expect(built().layout.body.blocks, 'сводка исчезла вместе с кнопкой').toBeDefined()
  })
})

describe('приоритет и годность имён (порядок здесь решает, на КАКУЮ сделку уйдёт опрос)', () => {
  it('негодное значение в первом имени НЕ съедает годное во втором', () => {
    // Перебираем до первого ГОДНОГО значения, а не до первого присутствующего ключа: иначе `ID: '0'`
    // рядом с верным `dealId` терял бы сделку целиком.
    expect(readWidgetParams({ ID: '0', dealId: '759' }).dealId).toBe(759)
    expect(readWidgetParams({ ID: 'abc', DEAL_ID: '42' }).dealId).toBe(42)
    expect(readWidgetParams({ surveyKey: '   ', SURVEY_KEY: 'k' }).surveyKey).toBe('k')
  })

  it('ПУСТАЯ строка в первом имени не съедает значение во втором', () => {
    // Форм-кодирование B24 охотно отдаёт `''`. При `{token:'', TOKEN:'настоящий'}` потеря токена
    // означала бы `hasIssuedInvitation === false` → виджет выпишет ВТОРОЕ приглашение, то есть ровно
    // тот дефект, ради которого модуль и написан.
    expect(readWidgetParams({ token: '', TOKEN: 'tok-1' }).token).toBe('tok-1')
    expect(readWidgetParams({ ID: '', dealId: '759' }).dealId).toBe(759)
  })

  it('НАШ `dealId` старше портального `ID`', () => {
    // Кнопка кладёт `dealId` явно; портал может добавить в options свой `ID`. Победи он — приглашение
    // ушло бы на ЧУЖУЮ сделку, а ответ клиента лёг бы не туда.
    expect(readWidgetParams({ ID: '10021', dealId: '759' }).dealId).toBe(759)
  })
})

describe('годность УЖЕ выписанной ссылки (кнопка на старом деле)', () => {
  it('сервер сказал «годна» → жива', () => {
    expect(readLinkVerdict(200, { ok: true })).toEqual({ state: 'alive' })
  })

  it('явный отказ → мёртвая, причину показываем как есть', () => {
    // Текст сервера уже написан для человека («Срок ссылки истёк…») — своего не сочиняем.
    expect(readLinkVerdict(403, { ok: false, error: 'Срок ссылки истёк, или опрос по ней уже пройден.' }))
      .toEqual({ state: 'dead', reason: 'Срок ссылки истёк, или опрос по ней уже пройден.' })
  })

  it('отказ без текста → мёртвая, но без выдуманной причины', () => {
    expect(readLinkVerdict(400, { ok: false })).toEqual({ state: 'dead' })
  })

  it('429 и 5xx → `unknown`, а НЕ «жива» и не «мертва»', () => {
    // «Мертва» заставила бы выписать вторую ссылку на живое приглашение — дубль ровно там, где мы от
    // него защищаемся. «Жива» — отправить клиенту израсходованную ссылку без единой оговорки.
    for (const status of [429, 500, 502, 503]) {
      expect(readLinkVerdict(status, { ok: false, error: 'Слишком много запросов.' }), String(status))
        .toEqual({ state: 'unknown' })
    }
  })

  it('мусор вместо тела → мёртвая без причины, без падения', () => {
    for (const body of [undefined, null, 'строка', 42]) {
      expect(readLinkVerdict(403, body)).toEqual({ state: 'dead' })
    }
  })
})

describe('вид виджета по вердикту (три состояния × известна ли сделка)', () => {
  it('жива → показываем ссылку, выписывать нечего', () => {
    expect(issuedLinkView({ state: 'alive' }, true)).toEqual({
      message: 'Приглашение уже готово. Отправьте клиенту эту ссылку:',
      showLink: true,
      showReissue: false
    })
  })

  it('мертва → ссылку НЕ показываем, предлагаем выписать новую', () => {
    const v = issuedLinkView({ state: 'dead', reason: 'Срок ссылки истёк.' }, true)
    expect(v.showLink).toBe(false)
    expect(v.showReissue).toBe(true)
    expect(v.message).toContain('Срок ссылки истёк.')
  })

  it('мертва и сделки нет → кнопки НЕТ, отправляем в карточку сделки', () => {
    // Без id сделки выписка всё равно не сработает: обещать «можно создать новую» там, где не можем,
    // хуже, чем сказать, откуда открыть виджет.
    const v = issuedLinkView({ state: 'dead' }, false)
    expect(v.showReissue).toBe(false)
    expect(v.message).toContain('из карточки сделки')
  })

  it('вердикта нет → ссылку показываем С ОГОВОРКОЙ и оставляем выписку', () => {
    // Ровно то, что терялось при слиянии `unknown` с `alive`: сотрудник уходил в состояние «готово»,
    // где кнопки выписки нет вовсе, и отправлял клиенту непроверенную ссылку как проверенную.
    const v = issuedLinkView({ state: 'unknown' }, true)
    expect(v.showLink).toBe(true)
    expect(v.showReissue).toBe(true)
    expect(v.message).toContain('проверить не удалось')
  })

  it('вердикта нет и сделки нет → ссылка есть, кнопки нет', () => {
    expect(issuedLinkView({ state: 'unknown' }, false)).toMatchObject({ showLink: true, showReissue: false })
  })
})
