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

  it('сводка переноса со стадиями считает пройденные вторым проходом, по стадии', () => {
    // Стадия — системное поле, и с узким перечнем полей портал её не отдаёт (замерено 28.09).
    expect(buildListSurveysCall(SURVEY).params.select).not.toContain('UF_CRM_10_STATE')
    expect(buildListSurveysCall(SURVEY, 0, true).params.filter).toEqual({ stageId: 'DT1040_16:SUCCESS' })

    const usage = tallySurveyUsage({ result: { items: [
      { UF_CRM_10_TEMPLATE_CODE: 'brand', UF_CRM_10_TEMPLATE_VERSION: 1 },
      { UF_CRM_10_TEMPLATE_CODE: 'brand', UF_CRM_10_TEMPLATE_VERSION: 1 },
    ] } }, SURVEY)
    tallySurveyUsage({ result: { items: [{ UF_CRM_10_TEMPLATE_CODE: 'brand', UF_CRM_10_TEMPLATE_VERSION: 1 }] } }, SURVEY, usage, 'completed')

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

  it('команды переноса пишут стадию, а не старое поле', () => {
    const planned = { code: 'brand', version: 1, title: 'Бренд', schema: SCHEMA }
    const created = fieldsOf(buildCreateTemplateCall(TEMPLATE, planned, 'published', new Date('2026-09-28T10:00:00Z')))
    const renamed = fieldsOf(buildPublishCall(TEMPLATE, {
      id: 4, code: 'brand', version: 1, name: 'Бренд', schema: SCHEMA, action: 'publish', issued: 0, setPublishedAt: true,
    } as Parameters<typeof buildPublishCall>[1], new Date('2026-09-28T10:00:00Z')))

    expect(created.stageId).toBe('DT1038_14:SUCCESS')
    expect(created).not.toHaveProperty('UF_CRM_8_STATE')
    expect(renamed.stageId).toBe('DT1038_14:SUCCESS')
    expect(renamed).not.toHaveProperty('UF_CRM_8_STATE')
  })
})
