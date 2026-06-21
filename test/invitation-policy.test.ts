import { describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { compile, diffVersions } from '../src/domain/compile'
import { surveyDraftSchema, type InvitationPolicy, type SurveyDraft } from '../src/domain/schema'
import { MemoryStore } from '../src/store/memory'
import { PgStore, type Queryable } from '../src/store/pg'
import { applySchema } from './helpers/schema'

// Базовые свойства invitationPolicySchema (дефолты, отказ на дублях каналов) покрыты
// в test/invitation.test.ts. Здесь — вшивание политики в draft/version/store.
const POLICY: InvitationPolicy = { entityType: 'deal', triggerStages: ['C1:WON', 'EXECUTING'], channelOrder: ['sms', 'email'] }

function draft(over: Partial<SurveyDraft> = {}): SurveyDraft {
  return {
    surveyKey: 'pol_survey',
    title: 'Опрос с политикой приглашения',
    lang: 'ru',
    questions: [
      { key: 'q_nps', type: 'single', metric: 'nps', required: true, text: 'Оцените', options: [{ key: 'n10', label: '10', score: 10 }] }
    ],
    invitationPolicy: POLICY,
    ...over
  }
}

describe('invitationPolicy в surveyDraft', () => {
  it('draft без политики валиден (back-compat) → undefined', () => {
    const d = surveyDraftSchema.parse({
      surveyKey: 's',
      title: 't',
      questions: [{ key: 'q', type: 'text', metric: 'text', text: '?' }]
    })
    expect(d.invitationPolicy).toBeUndefined()
  })

  it('пустая политика {} в draft → inner-дефолты (email,sms; без стадий)', () => {
    const parsed = surveyDraftSchema.parse({
      surveyKey: 's',
      title: 't',
      questions: [{ key: 'q', type: 'text', metric: 'text', text: '?' }],
      invitationPolicy: {}
    })
    expect(compile(parsed, 1).invitationPolicy).toEqual({ entityType: 'deal', triggerStages: [], channelOrder: ['email', 'sms'] })
  })
})

describe('compile вшивает invitationPolicy в версию', () => {
  it('переносит политику', () => {
    expect(compile(draft(), 1).invitationPolicy).toEqual(POLICY)
  })

  it('без политики → undefined', () => {
    expect(compile(draft({ invitationPolicy: undefined }), 1).invitationPolicy).toBeUndefined()
  })

  it('diffVersions НЕ зависит от смены политики (ряд остаётся сопоставим)', () => {
    const v1 = compile(draft(), 1)
    const v2 = compile(draft({ invitationPolicy: { entityType: 'deal', triggerStages: ['OTHER'], channelOrder: ['email'] } }), 2)
    // Вопросы идентичны → все unchanged; политика приглашения на классы изменений не влияет.
    expect(Object.values(diffVersions(v1, v2)).every((c) => c === 'unchanged')).toBe(true)
  })
})

describe('политика переживает запись/чтение и заморожена по версиям', () => {
  it('MemoryStore: getVersion/currentVersion + иммутабельность v1↔v2', async () => {
    const store = new MemoryStore()
    await store.publish(draft(), 1)
    await store.publish(draft({ invitationPolicy: undefined }), 2)
    expect((await store.getVersion('pol_survey', 1))?.invitationPolicy).toEqual(POLICY)
    expect((await store.getVersion('pol_survey', 2))?.invitationPolicy).toBeUndefined()
    expect((await store.currentVersion('pol_survey'))?.invitationPolicy).toBeUndefined() // текущая = v2
  })

  it('PgStore (pglite): round-trip через compiled_schema JSONB + иммутабельность', async () => {
    const pg = new PGlite()
    try {
      await applySchema(pg)
      const db = pg as unknown as Queryable
      const { rows } = await db.query<{ id: number }>(
        "insert into portal (member_id, domain, tokens) values ('m-pol', 'pol.b24', '{}'::jsonb) returning id"
      )
      const store = new PgStore(db, { portalId: rows[0]!.id })
      await store.publish(draft(), 1)
      await store.publish(draft({ invitationPolicy: undefined }), 2)
      expect((await store.getVersion('pol_survey', 1))?.invitationPolicy).toEqual(POLICY)
      expect((await store.getVersion('pol_survey', 2))?.invitationPolicy).toBeUndefined()
      expect((await store.currentVersion('pol_survey'))?.invitationPolicy).toBeUndefined()
    } finally {
      await pg.close()
    }
  })
})
