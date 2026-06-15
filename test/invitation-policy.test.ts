import { describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { compile } from '../src/domain/compile'
import { invitationPolicySchema, surveyDraftSchema, type SurveyDraft } from '../src/domain/schema'
import { MemoryStore } from '../src/store/memory'
import { PgStore, type Queryable } from '../src/store/pg'
import { applySchema } from './helpers/schema'

const POLICY = { triggerStages: ['C1:WON', 'EXECUTING'], channelOrder: ['sms', 'email'] }

function draftWithPolicy(surveyKey = 'pol_survey'): SurveyDraft {
  return {
    surveyKey,
    title: 'Опрос с политикой приглашения',
    lang: 'ru',
    questions: [
      { key: 'q_nps', type: 'single', metric: 'nps', required: true, text: 'Оцените', options: [{ key: 'n10', label: '10', score: 10 }] }
    ],
    invitationPolicy: { triggerStages: ['C1:WON', 'EXECUTING'], channelOrder: ['sms', 'email'] }
  }
}

describe('invitationPolicy — схема', () => {
  it('пустой объект → дефолты (email→sms, без стадий)', () => {
    expect(invitationPolicySchema.parse({})).toEqual({ triggerStages: [], channelOrder: ['email', 'sms'] })
  })
  it('дубли каналов отвергаются', () => {
    expect(() => invitationPolicySchema.parse({ channelOrder: ['email', 'email'] })).toThrow()
  })
  it('surveyDraft без политики валиден (back-compat)', () => {
    const d = surveyDraftSchema.parse({
      surveyKey: 's',
      title: 't',
      questions: [{ key: 'q', type: 'text', metric: 'text', text: '?' }]
    })
    expect(d.invitationPolicy).toBeUndefined()
  })
})

describe('compile вшивает invitationPolicy в версию', () => {
  it('переносит политику в опубликованную версию', () => {
    expect(compile(draftWithPolicy(), 1).invitationPolicy).toEqual(POLICY)
  })
  it('без политики — undefined в версии', () => {
    const draft: SurveyDraft = {
      surveyKey: 's',
      title: 't',
      lang: 'ru',
      questions: [{ key: 'q', type: 'text', metric: 'text', required: false, text: '?', options: [] }]
    }
    expect(compile(draft, 1).invitationPolicy).toBeUndefined()
  })
})

describe('политика переживает запись/чтение', () => {
  it('MemoryStore: currentVersion отдаёт политику', async () => {
    const store = new MemoryStore()
    await store.publish(draftWithPolicy(), 1)
    expect((await store.currentVersion('pol_survey'))?.invitationPolicy).toEqual(POLICY)
  })

  it('PgStore (pglite): round-trip через compiled_schema JSONB', async () => {
    const pg = new PGlite()
    await applySchema(pg)
    const db = pg as unknown as Queryable
    const { rows } = await db.query<{ id: number }>(
      "insert into portal (member_id, domain, tokens) values ('m-pol', 'pol.b24', '{}'::jsonb) returning id"
    )
    const store = new PgStore(db, { portalId: rows[0]!.id })
    await store.publish(draftWithPolicy(), 1)
    expect((await store.getVersion('pol_survey', 1))?.invitationPolicy).toEqual(POLICY)
    await pg.close()
  })
})
