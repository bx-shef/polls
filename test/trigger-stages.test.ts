import { describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { MemoryStore } from '../src/store/memory'
import { PgStore, type Queryable } from '../src/store/pg'
import type { IStore } from '../src/store/types'
import type { SurveyDraft } from '../src/domain/schema'
import { applySchema } from './helpers/schema'

function draft(surveyKey: string, triggerStages: string[]): SurveyDraft {
  return {
    surveyKey,
    title: surveyKey,
    lang: 'ru',
    questions: [
      { key: 'q', type: 'single', metric: 'nps', required: true, text: '?', options: [{ key: 'n10', label: '10', score: 10 }] }
    ],
    invitationPolicy: { triggerStages, channelOrder: ['email', 'sms'] }
  }
}

// Контракт surveysTriggeredBy — общий для Memory и Pg (паритет реализаций).
async function expectTriggerContract(store: IStore): Promise<void> {
  await store.publish(draft('won_survey', ['C1:WON', 'EXECUTING']), 1)
  await store.publish(draft('exec_survey', ['EXECUTING']), 1)
  await store.publish(draft('none_survey', []), 1)

  expect(await store.surveysTriggeredBy('C1:WON')).toEqual(['won_survey'])
  expect(await store.surveysTriggeredBy('EXECUTING')).toEqual(['exec_survey', 'won_survey'])
  expect(await store.surveysTriggeredBy('NOPE')).toEqual([])
}

describe('surveysTriggeredBy — MemoryStore', () => {
  it('находит опросы по стадии-триггеру текущей версии', async () => {
    await expectTriggerContract(new MemoryStore())
  })

  it('учитывает только ТЕКУЩУЮ версию (политика заморожена по версиям)', async () => {
    const store = new MemoryStore()
    await store.publish(draft('s', ['OLD']), 1)
    await store.publish(draft('s', ['NEW']), 2)
    expect(await store.surveysTriggeredBy('NEW')).toEqual(['s'])
    expect(await store.surveysTriggeredBy('OLD')).toEqual([]) // старая версия больше не текущая
  })
})

describe('surveysTriggeredBy — PgStore (pglite, GIN по trigger_stages)', () => {
  it('паритет с MemoryStore + только текущая версия + tenant-изоляция', async () => {
    const pg = new PGlite()
    try {
      await applySchema(pg)
      const db = pg as unknown as Queryable
      const mkPortal = async (m: string) =>
        (await db.query<{ id: number }>(
          'insert into portal (member_id, domain, tokens) values ($1, $2, $3::jsonb) returning id',
          [m, `${m}.b24`, '{}']
        )).rows[0]!.id

      const storeA = new PgStore(db, { portalId: await mkPortal('trig-a') })
      await expectTriggerContract(storeA)

      // Текущая версия: republish v2 с новым триггером.
      const storeB = new PgStore(db, { portalId: await mkPortal('trig-b') })
      await storeB.publish(draft('s', ['OLD']), 1)
      await storeB.publish(draft('s', ['NEW']), 2)
      expect(await storeB.surveysTriggeredBy('NEW')).toEqual(['s'])
      expect(await storeB.surveysTriggeredBy('OLD')).toEqual([])

      // Tenant-изоляция: чужой портал не видит опросы storeA.
      expect(await storeB.surveysTriggeredBy('EXECUTING')).toEqual([])
    } finally {
      await pg.close()
    }
  })
})
