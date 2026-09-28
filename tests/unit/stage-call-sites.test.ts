import { describe, expect, it } from 'vitest'
import { buildCompleteSurveyCall } from '../../server/domain/answers/portal-calls'
import { buildCreateTemplateCall } from '../../server/domain/import/template-write'
import { buildListSurveysCall, buildPublishCall, tallySurveyUsage } from '../../server/domain/import/template-publish'
import { buildCreateSurveyItemCall, readPublishedTemplates } from '../../server/domain/invitations/portal-calls'
import { buildRevokeCall, issuedState, readIssuedLinks } from '../../server/domain/invitations/issued-links'
import { buildSurveyStateCall } from '../../server/domain/portals/stages'
import {
  buildNewVersionCall,
  buildPublishTemplateCall,
  findDraftOfCode,
  isFrozen,
  readTemplateItem,
} from '../../server/domain/templates/portal-calls'
import type { SurveyTemplate } from '../../server/domain/surveys/model'

/**
 * Места, где состояние пишется и читается, — со штатными стадиями (ревизия 5, issue #84, п. 21).
 *
 * ⚠ Зачем отдельно от `stages.test.ts`. Там проверены сами правила; здесь — что каждое место ими
 * пользуется. Прежние тесты этих мест работают со ссылками без воронки, то есть проверяют старый
 * путь через поле «Состояние», — и место, вернувшееся к записи поля напрямую, прошло бы их все,
 * а на портале со стадиями состояние терялось бы молча: поле после миграции удалено, и запись
 * в него портал отбрасывает без ошибки (замерено 28.09).
 */

const SURVEY = { entityTypeId: 1040, id: 10, categoryId: 16 }
const TEMPLATE = { entityTypeId: 1038, id: 8, categoryId: 14 }

const SCHEMA: SurveyTemplate = {
  code: 'brand',
  title: 'Бренд',
  sections: [{
    key: 's1',
    title: 'Раздел',
    scored: true,
    bands: [],
    questions: [{ key: 'q1', sourceKey: 'q1', title: 'Вопрос', type: 'scale', weight: 100, scored: true, scale: { min: 0, max: 10 } }],
  }],
}

const fieldsOf = (call: { params: Record<string, unknown> }) => call.params.fields as Record<string, unknown>

describe('«Результат опросов» со стадиями', () => {
  it('выпуск ставит «Отправлена», а поле «Состояние» не пишет', () => {
    const call = buildCreateSurveyItemCall(SURVEY, 2, {
      templateCode: 'brand',
      templateVersion: 1,
      expiresAt: new Date('2026-10-28T00:00:00Z'),
      title: 'Бренд — сделка',
    })

    expect(fieldsOf(call).stageId).toBe('DT1040_16:NEW')
    expect(fieldsOf(call)).not.toHaveProperty('UF_CRM_10_STATE')
  })

  it('запись ответов со стадиями не несёт ни стадии, ни старого поля', () => {
    const call = buildCompleteSurveyCall(SURVEY, 5, {
      answers: {},
      score: { sections: [], total: null },
      completedAt: new Date('2026-09-28T10:00:00Z'),
    } as unknown as Parameters<typeof buildCompleteSurveyCall>[2])

    expect(fieldsOf(call)).not.toHaveProperty('stageId')
    expect(fieldsOf(call)).not.toHaveProperty('UF_CRM_10_STATE')
    expect(fieldsOf(call)).toHaveProperty('UF_CRM_10_COMPLETED_AT')
  })

  it('отзыв ставит «Отозвана»', () => {
    expect(fieldsOf(buildRevokeCall(SURVEY, 5))).toEqual({ stageId: 'DT1040_16:FAIL' })
  })

  it('доставка пишет ответы без стадии, а «Пройдена» — отдельным вызовом', () => {
    // ⚠ Стадия в одной записи с ответами — и обязательное по стадии поле клиента отвергло бы
    // запись целиком: ответ крутился бы в буфере до предельного срока и пропал.
    const move = buildSurveyStateCall(SURVEY, 5, 'completed')

    expect(move.params).toEqual({ entityTypeId: 1040, id: 5, useOriginalUfNames: 'Y', fields: { stageId: 'DT1040_16:SUCCESS' } })
  })

  it('список ссылок стадию не читает вовсе: «пройдена» — по дате прохождения', () => {
    const links = readIssuedLinks({ result: { items: [
      { id: 1, stageId: 'DT1040_16:SUCCESS', UF_CRM_10_COMPLETED_AT: '' },
      { id: 2, stageId: 'DT1040_16:NEW', UF_CRM_10_COMPLETED_AT: '2026-09-20T03:00:00+03:00' },
    ] } }, SURVEY)
    const now = new Date('2026-09-28T10:00:00Z')

    expect(links.map(link => issuedState(link, now, 'sent'))).toEqual(['active', 'completed'])
  })

  it('сводка переноса со стадиями считает пройденные по дате прохождения, одним проходом', () => {
    // Стадия — системное поле, и с узким перечнем полей портал её не отдаёт (замерено 28.09);
    // дата прохождения — наше поле, его пишет только доставка.
    expect(buildListSurveysCall(SURVEY).params.select).toContain('UF_CRM_10_COMPLETED_AT')
    expect(buildListSurveysCall(SURVEY).params).not.toHaveProperty('filter')

    const usage = tallySurveyUsage({ result: { items: [
      { UF_CRM_10_TEMPLATE_CODE: 'brand', UF_CRM_10_TEMPLATE_VERSION: 1, UF_CRM_10_COMPLETED_AT: '2026-09-20T03:00:00+03:00' },
      { UF_CRM_10_TEMPLATE_CODE: 'brand', UF_CRM_10_TEMPLATE_VERSION: 1, UF_CRM_10_COMPLETED_AT: '' },
    ] } }, SURVEY)

    expect([...usage.values()]).toEqual([{ issued: 2, completed: 1 }])
  })
})

describe('«Шаблон опроса» со стадиями', () => {
  const published = { id: 4, stageId: 'DT1038_14:SUCCESS', UF_CRM_8_PUBLISHED_AT: '2026-09-28T03:00:00+03:00', UF_CRM_8_CODE: 'brand', UF_CRM_8_VERSION: 1, UF_CRM_8_SCHEMA: JSON.stringify(SCHEMA) }

  it('ГЛАВНОЕ: для выпуска — только с датой публикации и в стадии «Опубликован»', () => {
    // Черновик, перетащенный в «Опубликован», проверок схемы не проходил и выпускаться не должен.
    const dragged = { ...published, id: 6, UF_CRM_8_CODE: 'concept', UF_CRM_8_PUBLISHED_AT: '' }

    expect(readPublishedTemplates({ result: { items: [published, dragged] } }, TEMPLATE).map(one => one.code)).toEqual(['brand'])
  })

  it('ГЛАВНОЕ: виджет результата находит и снятые, и уведённые из «Опубликован» — по ним уже есть ответы', () => {
    const retired = { ...published, id: 5, UF_CRM_8_CODE: 'old', stageId: 'DT1038_14:FAIL' }
    const dragged = { ...published, id: 6, UF_CRM_8_CODE: 'moved', stageId: 'DT1038_14:NEW' }
    const draft = { ...published, id: 7, UF_CRM_8_CODE: 'draft', UF_CRM_8_PUBLISHED_AT: '' }
    const answer = { result: { items: [published, retired, dragged, draft] } }

    expect(readPublishedTemplates(answer, TEMPLATE, 'ever').map(one => one.code)).toEqual(['brand', 'old', 'moved'])
    expect(readPublishedTemplates(answer, TEMPLATE).map(one => one.code)).toEqual(['brand'])
  })

  it('конструктор видит опубликованную, перетащенную в «Черновик», неизменяемой', () => {
    const item = readTemplateItem({ result: { item: { ...published, stageId: 'DT1038_14:NEW' } } }, TEMPLATE)

    expect(isFrozen(item!.state)).toBe(true)
  })

  it('черновик кода ищется по дате публикации, а не по стадии', () => {
    const answer = { result: { items: [
      { id: 7, UF_CRM_8_CODE: 'brand', stageId: 'DT1038_14:SUCCESS', UF_CRM_8_PUBLISHED_AT: '' },
      { id: 8, UF_CRM_8_CODE: 'brand', stageId: 'DT1038_14:NEW', UF_CRM_8_PUBLISHED_AT: '2026-09-28' },
    ] } }

    expect(findDraftOfCode(answer, TEMPLATE, 'brand')).toBe(7)
  })

  it('публикация ставит «Опубликован» вместе с датой; новая версия — «Черновик»', () => {
    const publish = fieldsOf(buildPublishTemplateCall(TEMPLATE, 4, SCHEMA, 2, new Date('2026-09-28T10:00:00Z')))
    const draft = fieldsOf(buildNewVersionCall(TEMPLATE, SCHEMA))

    expect(publish.stageId).toBe('DT1038_14:SUCCESS')
    expect(publish.UF_CRM_8_PUBLISHED_AT).toBe('2026-09-28')
    expect(publish).not.toHaveProperty('UF_CRM_8_STATE')
    expect(draft.stageId).toBe('DT1038_14:NEW')
    expect(draft).not.toHaveProperty('UF_CRM_8_STATE')
  })

  it('команды переноса пишут стадию, а старое поле — только пока оно живо', () => {
    // Рядом со стадией старое поле пишется, пока оно на портале: вебхук не видит, чем читает
    // приложение (разбор у `writesLegacyState`).
    const planned = { code: 'brand', version: 1, title: 'Бренд', schema: SCHEMA }
    const publish = { id: 4, code: 'brand', version: 1, name: 'Бренд', schema: SCHEMA, action: 'publish', issued: 0, setPublishedAt: true } as Parameters<typeof buildPublishCall>[1]
    const at = new Date('2026-09-28T10:00:00Z')

    for (const legacy of [false, true]) {
      const created = fieldsOf(buildCreateTemplateCall(TEMPLATE, planned, 'published', at, legacy))
      const published = fieldsOf(buildPublishCall(TEMPLATE, publish, at, legacy))

      expect(created.stageId).toBe('DT1038_14:SUCCESS')
      expect(published.stageId).toBe('DT1038_14:SUCCESS')
      expect([created.UF_CRM_8_STATE, published.UF_CRM_8_STATE]).toEqual(legacy ? ['published', 'published'] : [undefined, undefined])
    }
  })

  it('ГЛАВНОЕ: переименование опубликованной версии стадию не трогает — снятая остаётся снятой', () => {
    // ⚠ Переименование досталось и снятым с публикации (`isFrozen`). Пиши оно стадию
    // «Опубликован», повторный запуск команды вернул бы в выпуск версию, которую администратор
    // снял, — в обход его решения. Нашли `/review`, `/code-review` и программист в панели PR #93.
    // И при живом старом поле — тоже: переименование состояния не трогает вовсе.
    const fields = fieldsOf(buildPublishCall(TEMPLATE, {
      id: 4, code: 'brand', version: 1, name: 'Бренд 2024', schema: SCHEMA, action: 'rename', issued: 0, setPublishedAt: false,
    } as Parameters<typeof buildPublishCall>[1], new Date('2026-09-28T10:00:00Z'), true))

    expect(fields).not.toHaveProperty('stageId')
    expect(fields).not.toHaveProperty('UF_CRM_8_STATE')
    expect(fields.title).toBe('Бренд 2024')
  })
})
