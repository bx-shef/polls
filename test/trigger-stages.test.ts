import { describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { MemoryStore } from '../src/store/memory'
import { PgStore, type Queryable } from '../src/store/pg'
import type { IStore } from '../src/store/types'
import type { SurveyDraft } from '../src/domain/schema'
import { applySchema } from './helpers/schema'

const QUESTIONS: SurveyDraft['questions'] = [
  { key: 'q', type: 'single', metric: 'nps', required: true, text: '?', options: [{ key: 'n10', label: '10', score: 10 }] }
]

function draft(surveyKey: string, triggerStages: string[]): SurveyDraft {
  return { surveyKey, title: surveyKey, lang: 'ru', questions: QUESTIONS, invitationPolicy: { entityType: 'deal', triggerStages, channelOrder: ['email', 'sms'] } }
}

// Опрос вообще без invitationPolicy — путь `?? []` и «не попадает в результат».
function noPolicyDraft(surveyKey: string): SurveyDraft {
  return { surveyKey, title: surveyKey, lang: 'ru', questions: QUESTIONS }
}

// Контракт surveysTriggeredBy — общий для Memory и Pg (паритет реализаций).
// Результат всегда отсортирован по survey_key (см. IStore.surveysTriggeredBy).
async function expectTriggerContract(store: IStore): Promise<void> {
  await store.publish(draft('won_survey', ['C1:WON', 'EXECUTING']), 1)
  await store.publish(draft('exec_survey', ['EXECUTING']), 1)
  await store.publish(draft('none_survey', []), 1) // политика есть, стадий нет
  await store.publish(noPolicyDraft('no_policy'), 1) // политики нет вовсе

  expect(await store.surveysTriggeredBy('C1:WON')).toEqual(['won_survey'])
  expect(await store.surveysTriggeredBy('EXECUTING')).toEqual(['exec_survey', 'won_survey'])
  expect(await store.surveysTriggeredBy('NOPE')).toEqual([]) // none_survey/no_policy не триггерятся никогда
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

  it('экземпляры изолированы (нет общего состояния)', async () => {
    const a = new MemoryStore()
    const b = new MemoryStore()
    await a.publish(draft('only_a', ['X']), 1)
    expect(await a.surveysTriggeredBy('X')).toEqual(['only_a'])
    expect(await b.surveysTriggeredBy('X')).toEqual([])
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

      // GIN-индекс реально создан миграцией 0002 (иначе @> ушёл бы в seq-scan).
      const idx = await db.query<{ indexname: string }>(
        "select indexname from pg_indexes where tablename = 'survey_version' and indexdef ilike '%gin%'"
      )
      expect(idx.rows.map((r) => r.indexname)).toContain('idx_survey_version_trigger_stages')

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
