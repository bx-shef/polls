import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_COLOR_BAD,
  ACTIVITY_COLOR_GOOD,
  activityDeadline,
  activityOriginId,
  buildActivityTitle,
  buildFindActivityCall,
  buildIssueActivityDescription,
  buildIssueActivityTitle,
  buildOverwriteActivityCall,
  buildRevokedActivityCall,
  buildRevokedTitle,
  buildTodoActivityCall,
  capTitle,
  formatExpiryDay,
  hasBadSection,
  isUntouchedIssueActivity,
  ISSUE_TITLE_PREFIX,
  linkActivityOriginId,
  MAX_TITLE_BYTES,
  ownerOf,
  readActivityId,
  readBindApplied,
  readFoundActivity,
  readFoundActivityId,
  REVOKED_TITLE_PREFIX,
} from '../../server/domain/answers/timeline-activity'
import type { SurveyTemplate } from '../../server/domain/surveys/model'
import { scoreSurvey } from '../../server/domain/surveys/scoring'

/**
 * Чистая часть дела в таймлайне: цвет, заголовок, разбор ответов.
 *
 * Транспорт (поиск по метке, компенсирующее удаление) проверяется в `answer-delivery.test.ts`
 * подделкой портала — там, где он и живёт.
 */

const TEMPLATE: SurveyTemplate = {
  code: 'demo',
  title: 'Оценка работы по проекту',
  sections: [
    {
      key: 'product',
      title: 'Результат',
      scored: true,
      questions: [
        { key: 'q', sourceKey: 'q', title: 'Довольны?', type: 'scale', weight: 1, scored: true, scale: { min: 0, max: 10 } },
      ],
      bands: [
        { from: 0, to: 6.5, text: 'Мы вас подвели.' },
        { from: 6.5, to: 8.5, text: 'Есть что улучшить.' },
        { from: 8.5, to: 10, text: 'Спасибо!' },
      ],
    },
  ],
}

const score = (value: number | null) => scoreSurvey(TEMPLATE, { q: value })

describe('цвет дела', () => {
  it('красный, когда раздел упал в САМЫЙ НИЖНИЙ свой диапазон', () => {
    expect(hasBadSection(TEMPLATE, score(3))).toBe(true)
  })

  it('не красный на середине и наверху', () => {
    expect(hasBadSection(TEMPLATE, score(7))).toBe(false)
    expect(hasBadSection(TEMPLATE, score(10))).toBe(false)
  })

  it('порог берётся из шаблона, а не из нашего кода', () => {
    // ⚠ Прямое следствие правила «средний балл не выносится главной метрикой». Нижний
    // диапазон — это то, что клиент назвал плохим у себя. Придумав свою границу, мы
    // покрасили бы дело вопреки тому, что он написал в анкете.
    const strict: SurveyTemplate = {
      ...TEMPLATE,
      sections: [{ ...TEMPLATE.sections[0]!, bands: [{ from: 0, to: 9, text: 'плохо' }, { from: 9, to: 10, text: 'хорошо' }] }],
    }

    expect(hasBadSection(strict, scoreSurvey(strict, { q: 8 }))).toBe(true)
    expect(hasBadSection(TEMPLATE, score(8))).toBe(false)
  })

  it('два диапазона от ОДНОЙ границы не красят дело вслепую', () => {
    // ⚠ ГВАРД ПОД НАХОДКУ ПАНЕЛИ РЕВЬЮ (issue #42, пункт 3). Прежняя редакция сверяла
    // диапазоны по `from`, а `findBand` отдаёт сам элемент `bands`. Совпали границы —
    // и верхний диапазон считался нижним: дело краснело вопреки тому, что клиент написал
    // в анкете. Появляются такие шаблоны не в теории, а после ручной правки и после импорта
    // из старого решения, где границы диапазонов никто не проверял.
    const twins: SurveyTemplate = {
      ...TEMPLATE,
      sections: [{
        ...TEMPLATE.sections[0]!,
        bands: [
          { from: 0, to: 5, text: 'нижний' },
          // Та же нижняя граница, что у первого, но диапазон другой и текст другой.
          { from: 0, to: 10, text: 'верхний' },
        ],
      }],
    }

    // Балл 8 попадает во ВТОРОЙ диапазон: `findBand` берёт первый подходящий по порядку,
    // а 8 в «0–5» не входит. Нижний — первый, и дело краснеть не должно.
    const scored = scoreSurvey(twins, { q: 8 })

    expect(scored.sections[0]!.band!.text).toBe('верхний')
    expect(hasBadSection(twins, scored)).toBe(false)
  })

  it('раздел без диапазонов ничего не решает', () => {
    // Сказать про него «плохо» не на чем.
    const bandless: SurveyTemplate = { ...TEMPLATE, sections: [{ ...TEMPLATE.sections[0]!, bands: [] }] }

    expect(hasBadSection(bandless, scoreSurvey(bandless, { q: 0 }))).toBe(false)
  })

  it('балл НИЖЕ нижнего диапазона красит дело', () => {
    // У перенесённых анкет диапазоны бывают с дырой внизу (у `digital` — с 4). Балл,
    // упавший в непокрытый низ, — хуже худшего диапазона, а не «ничего». Нашёл `/code-review`
    // в PR #85: раздел из одних пропусков оставлял дело зелёным.
    const holed: SurveyTemplate = {
      ...TEMPLATE,
      sections: [{
        ...TEMPLATE.sections[0]!,
        bands: [{ from: 4, to: 7, text: 'Средне.' }, { from: 7, to: 10, text: 'Хорошо.' }],
      }],
    }

    expect(hasBadSection(holed, scoreSurvey(holed, { q: null }))).toBe(true)
    expect(hasBadSection(holed, scoreSurvey(holed, { q: 2 }))).toBe(true)
    expect(hasBadSection(holed, scoreSurvey(holed, { q: 8 }))).toBe(false)
  })

  it('пропуск красит дело, как низшая оценка', () => {
    // Решение владельца 28.09 (issue #84, пункт 5): не ответил — значит низшая оценка, и раздел
    // без единого ответа попадает в свой нижний диапазон. До него здесь было наоборот —
    // промолчавший клиент выглядел в ленте зелёным.
    expect(hasBadSection(TEMPLATE, score(null))).toBe(true)
  })

  it('цвет отправляется всегда', () => {
    // ⚠ У жёлтого идентификатора нет — он получается, если `colorId` не передать. Значит
    // забытый параметр читался бы на портале как осознанный выбор.
    const call = buildTodoActivityCall({
      dealEntityTypeId: 2,
      dealId: 1,
      title: 'т',
      description: 'о',
      deadline: new Date('2026-09-21T12:00:00Z'),
      color: ACTIVITY_COLOR_BAD,
    })

    expect(call.params.colorId).toBe(ACTIVITY_COLOR_BAD)
    expect(ACTIVITY_COLOR_BAD).not.toBe(ACTIVITY_COLOR_GOOD)
  })

  it('срок уходит С ЧАСОВЫМ ПОЯСОМ', () => {
    // ⚠ Гвард под живой дефект. Первая редакция обрезала зону, потому что пример
    // в документации показан без неё. `toISOString()` даёт UTC, портал прочитал время
    // как СВОЁ местное, и дело родилось просроченным на три часа: на портале стояло
    // `CREATED 07:22:23+03:00` при `DEADLINE 04:22:23+03:00`. Момент времени обязан быть
    // однозначным — часового пояса чужого портала мы не знаем и знать не обязаны.
    const call = buildTodoActivityCall({
      dealEntityTypeId: 2,
      dealId: 1,
      title: 'т',
      description: 'о',
      deadline: new Date('2026-09-21T12:00:00.000Z'),
      color: ACTIVITY_COLOR_GOOD,
    })

    expect(call.params.deadline).toBe('2026-09-21T12:00:00.000Z')
    expect(String(call.params.deadline)).toMatch(/Z$/)
  })

  it('срок не наступает в момент создания', () => {
    // Дело со сроком «сейчас» просрочено через секунду после появления — то есть выглядит
    // поломкой ровно там, где мы её только что чинили.
    const now = new Date('2026-09-21T12:00:00.000Z')

    expect(activityDeadline(now).getTime()).toBeGreaterThan(now.getTime())
    expect(activityDeadline(now).toISOString()).toBe('2026-09-22T12:00:00.000Z')
  })
})

describe('заголовок дела', () => {
  it('несёт название анкеты и итог', () => {
    expect(buildActivityTitle(TEMPLATE, score(9))).toBe('Опрос пройден: Оценка работы по проекту — 9')
  })

  it('балл в русской записи', () => {
    const half: SurveyTemplate = {
      ...TEMPLATE,
      sections: [{
        ...TEMPLATE.sections[0]!,
        questions: [
          TEMPLATE.sections[0]!.questions[0]!,
          { key: 'w', sourceKey: 'w', title: 'Срок?', type: 'scale', weight: 1, scored: true, scale: { min: 0, max: 10 } },
        ],
      }],
    }

    expect(buildActivityTitle(half, scoreSurvey(half, { q: 9, w: 8 }))).toContain('8,5')
  })

  it('без итога хвоста нет', () => {
    // Итога нет только у анкеты без балльных разделов: пропуски дают низший балл, а не пустоту.
    const openOnly: SurveyTemplate = {
      ...TEMPLATE,
      sections: TEMPLATE.sections.map(section => ({ ...section, scored: false })),
    }

    expect(buildActivityTitle(openOnly, scoreSurvey(openOnly, { q: null }))).toBe('Опрос пройден: Оценка работы по проекту')
  })

  it('пропуск даёт в заголовке низший итог, а не пустоту', () => {
    expect(buildActivityTitle(TEMPLATE, score(null))).toBe('Опрос пройден: Оценка работы по проекту — 0')
  })

  it('режется и по символам, и по БАЙТАМ', () => {
    // ⚠ Два предела, а не один: портал считает символы, а правило проекта требует мерить
    // байты, потому что кириллица весит вдвое. Обрезав только по символам, мы отдали бы
    // в поле на 255 строку в 500 байт.
    const capped = capTitle('я'.repeat(400))

    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(MAX_TITLE_BYTES)
    expect(capped.length).toBeLessThan(400)
  })

  it('короткий заголовок не трогает', () => {
    expect(capTitle('Опрос пройден')).toBe('Опрос пройден')
  })
})

describe('разбор ответов портала', () => {
  it('принимает обе формы идентификатора созданного дела', () => {
    // ⚠ Документация обещает `{result:{id}}`, у соседа часть порталов отвечала `{result: id}`.
    expect(readActivityId({ result: { id: 999 } })).toBe('999')
    expect(readActivityId({ result: 999 })).toBe('999')
  })

  it('не принимает за идентификатор то, что им не является', () => {
    // Приняв мусор, мы нанесли бы метку в пустоту и спрятали поломку за успешным вызовом.
    expect(readActivityId({ result: { id: 'abc' } })).toBeNull()
    expect(readActivityId({ result: null })).toBeNull()
    expect(readActivityId(null)).toBeNull()
  })

  it('привязку принятой считает только `true`: `false` — задокументированный отказ двухсотым', () => {
    expect(readBindApplied({ result: true })).toBe(true)
    expect(readBindApplied({ result: false })).toBe(false)
    expect(readBindApplied(null)).toBe(false)
  })

  it('пустой поиск — это «ещё не писали», а не ошибка', () => {
    expect(readFoundActivityId({ result: [] })).toBeNull()
    expect(readFoundActivityId(null)).toBeNull()
    expect(readFoundActivityId({ result: [{ ID: 42 }] })).toBe('42')
  })
})

describe('дело выпуска: «Отправить опрос клиенту» (#84, п. 14)', () => {
  const URL = 'https://polls.example/s/abc123'
  const EXPIRES = new Date('2026-10-29T02:43:00Z')

  it('ГЛАВНОЕ: ключ выпуска свой и не находится ключом итога — ни целиком, ни началом', () => {
    // ⚠ С общим ключом повтор доставки нашёл бы закрытое менеджером дело выпуска и решил бы,
    // что итог уже записан. Фильтр портала — точное совпадение (замер 29.09), но и сами строки
    // не должны быть началом друг друга: ключ элемента 7 не должен быть началом ключа элемента 78.
    expect(linkActivityOriginId(1040, 78)).not.toBe(activityOriginId(1040, 78))
    expect(linkActivityOriginId(1040, 78).startsWith(activityOriginId(1040, 7))).toBe(false)
    expect(linkActivityOriginId(1040, 78).startsWith(activityOriginId(1040, 78))).toBe(false)
  })

  it('ГЛАВНОЕ: ключи несут тип смарт-процесса — пересозданный не находит дел прежнего', () => {
    // ⚠ У пересозданного смарт-процесса номера элементов считаются заново, а дела живут в сделках.
    // Без типа новый элемент 12 нашёл бы дело старого элемента 12 из другой сделки — итог «уже
    // записан» и не записался бы вовсе (`/code-review`, PR #102).
    expect(activityOriginId(1040, 12)).not.toBe(activityOriginId(1052, 12))
    expect(linkActivityOriginId(1040, 12)).not.toBe(linkActivityOriginId(1052, 12))
    expect(activityOriginId(1040, 12)).toBe('survey-1040-12')
    expect(linkActivityOriginId(1040, 12)).toBe('survey-link-1040-12')
  })

  it('в описании — выпущенный адрес и день окончания', () => {
    const text = buildIssueActivityDescription(URL, EXPIRES)

    expect(text).toContain(URL)
    expect(text).toContain('Действует до 29.10.2026')
  })

  it('день окончания считается в UTC+3: вечер по UTC — это уже завтра в Минске и Москве', () => {
    // ⚠ Пояс чужого портала неизвестен, текст дела портал не переводит (разбор у `formatExpiryDay`).
    expect(formatExpiryDay(new Date('2026-10-29T20:59:00Z'))).toBe('29.10.2026')
    expect(formatExpiryDay(new Date('2026-10-29T21:00:00Z'))).toBe('30.10.2026')
  })

  it('заголовок — наш префикс и название анкеты, в пределе байтов', () => {
    expect(buildIssueActivityTitle('Бренд')).toBe(`${ISSUE_TITLE_PREFIX}Бренд`)
    expect(buildIssueActivityTitle('')).toBe(`${ISSUE_TITLE_PREFIX}Опрос`)
    expect(Buffer.byteLength(buildIssueActivityTitle('я'.repeat(400)), 'utf8')).toBeLessThanOrEqual(MAX_TITLE_BYTES)
  })

  it('без цвета — портальный по умолчанию; итог цвет передаёт всегда', () => {
    const base = { dealEntityTypeId: 2, dealId: 42, title: 't', description: 'd', deadline: new Date(0) }

    expect(buildTodoActivityCall(base).params).not.toHaveProperty('colorId')
    expect(buildTodoActivityCall({ ...base, color: ACTIVITY_COLOR_GOOD }).params).toMatchObject({ colorId: ACTIVITY_COLOR_GOOD })
  })
})

describe('найденное дело', () => {
  it('поиск просит закрыто ли дело, чьё оно и как называется', () => {
    expect(buildFindActivityCall('survey-link-1040-78').params.select).toEqual(['ID', 'COMPLETED', 'OWNER_TYPE_ID', 'OWNER_ID', 'SUBJECT', 'DESCRIPTION'])
  })

  it('без владельца и заголовка — нули и пустая строка, а не падение', () => {
    // ⚠ Заголовок дальше режут `startsWith` (`buildRevokedTitle`): не строкой он уронил бы отзыв
    // изнутри, и в журнале стоял бы посторонний диагноз. Нашёл тестировщик в панели PR #102.
    expect(readFoundActivity({ result: [{ ID: '1', COMPLETED: 'N' }] }))
      .toEqual({ id: '1', completed: false, ownerTypeId: 0, ownerId: 0, subject: '', description: '' })
    expect(readFoundActivity({ result: [{ ID: '1', SUBJECT: 42 }] })?.subject).toBe('')
  })

  it('читает закрытость, владельца и заголовок так, как отдаёт портал — строками', () => {
    // Форма строки — с живого портала 29.09: числа строками, `COMPLETED` — `Y`/`N`.
    const answer = { result: [{ ID: '308', COMPLETED: 'N', OWNER_TYPE_ID: '1040', OWNER_ID: '78', SUBJECT: 'Отправить опрос клиенту: brand' }] }

    expect(readFoundActivity(answer)).toEqual({ id: '308', completed: false, ownerTypeId: 1040, ownerId: 78, subject: 'Отправить опрос клиенту: brand', description: '' })
    expect(readFoundActivity({ result: [{ ID: '308', COMPLETED: 'Y' }] })?.completed).toBe(true)
    expect(readFoundActivity({ result: [] })).toBeNull()
  })

  it('владелец — тот, кого назвал портал; не назвал — сделка', () => {
    const found = { id: '1', completed: false, ownerTypeId: 1040, ownerId: 78, subject: '', description: '' }

    expect(ownerOf(found, 42)).toEqual({ entityTypeId: 1040, entityId: 78 })
    expect(ownerOf({ ...found, ownerTypeId: 0 }, 42)).toEqual({ entityTypeId: 2, entityId: 42 })
  })
})

describe('перезапись итогом', () => {
  it('ответственный уходит в перезапись, когда он известен', () => {
    const call = buildOverwriteActivityCall('308', { entityTypeId: 2, entityId: 42 }, {
      title: 't',
      description: 'd',
      deadline: new Date(0),
      color: ACTIVITY_COLOR_GOOD,
      responsibleId: 5,
    })

    expect(call.params).toMatchObject({ responsibleId: 5 })
  })

  it('ГЛАВНОЕ: `todo.update` с владельцем, сроком, заголовком, текстом и цветом', () => {
    // ⚠ `deadline` в этом методе обязателен в каждом вызове (документация) — без него портал
    // отказал бы, и итог ушёл бы новым делом рядом, оставив в ленте адрес.
    const call = buildOverwriteActivityCall('308', { entityTypeId: 1040, entityId: 78 }, {
      title: 'Опрос пройден: brand — 7,2',
      description: '[B]Опрос пройден: brand[/B]',
      deadline: new Date('2026-09-30T00:00:00Z'),
      color: ACTIVITY_COLOR_GOOD,
      responsibleId: 0,
    })

    expect(call).toEqual({
      method: 'crm.activity.todo.update',
      params: {
        id: 308,
        ownerTypeId: 1040,
        ownerId: 78,
        deadline: '2026-09-30T00:00:00.000Z',
        title: 'Опрос пройден: brand — 7,2',
        description: '[B]Опрос пройден: brand[/B]',
        colorId: ACTIVITY_COLOR_GOOD,
      },
    })
  })
})

describe('нетронутое ли дело выпуска', () => {
  const URL_ = 'https://polls.example/s/abc123'
  const found = (subject: string, description: string) => ({ id: '1', completed: false, ownerTypeId: 2, ownerId: 42, subject, description })
  const ours = buildIssueActivityDescription(URL_, new Date('2026-10-29T02:43:00Z'))

  it('ровно наши заголовок и описание — нетронутое', () => {
    expect(isUntouchedIssueActivity(found(`${ISSUE_TITLE_PREFIX}brand`, ours))).toBe(true)
  })

  it('перевод строки портала `\\r\\n` нетронутым делом считается', () => {
    expect(isUntouchedIssueActivity(found(`${ISSUE_TITLE_PREFIX}brand`, ours.replaceAll('\n', '\r\n')))).toBe(true)
  })

  it('дописанная строка, правка строки или чужой заголовок — тронутое', () => {
    expect(isUntouchedIssueActivity(found(`${ISSUE_TITLE_PREFIX}brand`, `${ours}\nзаметка`))).toBe(false)
    expect(isUntouchedIssueActivity(found(`${ISSUE_TITLE_PREFIX}brand`, ours.replace('Действует до', 'Действовала до')))).toBe(false)
    expect(isUntouchedIssueActivity(found('Позвонить Иванову', ours))).toBe(false)
    expect(isUntouchedIssueActivity(found(`${ISSUE_TITLE_PREFIX}brand`, ''))).toBe(false)
  })

  it('текст дела выпуска честно говорит, что будет при закрытии', () => {
    // Закрытое дело портал не перезаписывает — итог приходит новым делом рядом (решение владельца, п. 14).
    expect(ours).toContain('Закроете раньше — итог придёт новым делом рядом.')
  })
})

describe('закрытие при отзыве', () => {
  const found = {
    id: '308',
    completed: false,
    ownerTypeId: 1040,
    ownerId: 78,
    subject: `${ISSUE_TITLE_PREFIX}brand`,
    description: buildIssueActivityDescription('https://polls.example/s/abc123', new Date('2026-10-29T02:43:00Z')),
  }

  it('ГЛАВНОЕ: описание, которое правил человек, не заменяется — заметка менеджера цела', () => {
    // Закрытое дело потом не поправить, и «клиент просил перезвонить в пятницу» пропало бы без следа
    // (`/code-review`, замыкающий проход PR #102). Адрес в нём остаётся, но отозван.
    const touched = { ...found, description: `${found.description}\nклиент просил перезвонить в пятницу` }

    const fields = buildRevokedActivityCall(touched, '[sh] Ссылки на опросы').params.fields as Record<string, unknown>

    expect(fields).not.toHaveProperty('DESCRIPTION')
    expect(fields).toMatchObject({ SUBJECT: `${REVOKED_TITLE_PREFIX}brand`, COMPLETED: 'Y' })
  })

  it('ГЛАВНОЕ: одним вызовом — тема, текст без адреса и «выполнено»', () => {
    // ⚠ Двумя вызовами дело могло бы остаться открытым с текстом «отозвана» или закрытым
    // с живым на вид адресом.
    const call = buildRevokedActivityCall(found, '[sh] Ссылки на опросы')

    expect(call.method).toBe('crm.activity.update')
    const fields = call.params.fields as Record<string, unknown>
    expect(fields).toMatchObject({ SUBJECT: `${REVOKED_TITLE_PREFIX}brand`, DESCRIPTION_TYPE: 2, COMPLETED: 'Y' })
    expect(String(fields.DESCRIPTION)).not.toContain('/s/')
    expect(String(fields.DESCRIPTION)).toContain('[sh] Ссылки на опросы')
  })

  it('чужой заголовок сохраняется целиком и получает префикс спереди', () => {
    // Менеджер мог переписать тему дела — выбрасывать написанное им нельзя.
    expect(buildRevokedTitle('Позвонить Иванову')).toBe(`${REVOKED_TITLE_PREFIX}Позвонить Иванову`)
    expect(buildRevokedTitle('')).toBe(`${REVOKED_TITLE_PREFIX}Опрос`)
  })
})
