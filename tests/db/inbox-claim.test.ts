import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { requeueStuck } from '../../server/answers/deliver'
import { getDb, isDatabaseConfigured, schema } from '../../server/db/client'

/**
 * Захват строк буфера — единственное место в приложении, где написана настоящая
 * параллельность. Подделкой базы оно не проверяется: `FOR UPDATE SKIP LOCKED` и сравнение
 * колонок — это поведение Postgres, а не нашего кода, и мок подтвердил бы любую чушь.
 *
 * ⚠ Файл появился по следам конкретного дефекта: `requeueStuck` сравнивал `received_at`
 * вместо времени захвата. Ответ, пролежавший в буфере дольше срока — то есть ровно тот,
 * ради которого написан возврат подвисших, — забирался бы обратно через секунду после того,
 * как его взяли, и уезжал бы в портал ДВАЖДЫ. Ни один юнит-тест этого поймать не мог.
 * Нашла панель ревью PR #22, дефект найден своим перечитыванием диффа.
 *
 * Без `DATABASE_URL` файл пропускает себя сам: в CI базу поднимает сервис, локально —
 * `make up`.
 */

const enabled = isDatabaseConfigured()

/** Портал-пустышка: строки буфера ссылаются на него внешним ключом. */
let portalId: string

async function seed(receivedAt: Date, nextAttemptAt: Date, status = 'pending'): Promise<string> {
  const rows = await getDb()
    .insert(schema.inbox)
    .values({ portalId, tokenHash: randomUUID(), payload: {}, receivedAt, nextAttemptAt, status })
    .returning({ id: schema.inbox.id })
  return rows[0]!.id
}

async function statusOf(id: string): Promise<string> {
  const rows = await getDb()
    .select({ status: schema.inbox.status })
    .from(schema.inbox)
    .where(sql`${schema.inbox.id} = ${id}`)
  return rows[0]!.status
}

/**
 * ⚠ Чистим ТОЛЬКО свой портал, а не таблицу.
 *
 * Здесь стояло `truncate table inbox cascade` — в `beforeEach` и в `afterAll`. У того, кто
 * запустил `pnpm check` с `DATABASE_URL` на живой базе, это стирало ВСЕ недоставленные ответы
 * всех порталов, то есть ровно то, что инвариант проекта запрещает терять в принципе. Тест,
 * написанный ради «ответ не теряется никогда», сам его и нарушал.
 *
 * Отдельного удаления строк буфера не нужно: `inbox.portal_id` объявлен
 * `onDelete: 'cascade'`, и удаление портала-пустышки уносит его строки само.
 *
 * ⚠ Соседний `portal-lifecycle.test.ts` про этот файл утверждал, что он «уже избегает этого
 * и чистит по своему домену». Это было неправдой с первого дня — проверено перечитыванием
 * при ответе на вопрос владельца, что переживает перезапуск сервера. Утверждение исправлено
 * там же: соседний файл в роли образца опаснее отсутствующего образца.
 */
const TEST_DOMAIN = 'db-test.bitrix24.ru'

async function wipe() {
  await getDb().execute(sql`delete from ${schema.portals} where domain = ${TEST_DOMAIN}`)
}

describe.skipIf(!enabled)('возврат подвисших строк', () => {
  beforeEach(async () => {
    await wipe()
    const rows = await getDb()
      .insert(schema.portals)
      .values({ memberId: randomUUID(), domain: TEST_DOMAIN })
      .returning({ id: schema.portals.id })
    portalId = rows[0]!.id
  })

  afterAll(async () => {
    if (!enabled) return
    await wipe()
  })

  it('НЕ забирает строку, которую взяли только что, даже если лежит она давно', async () => {
    // Тот самый дефект. Ответ поступил вчера (портал был недоступен, попытки откладывались),
    // а в работу его взяли секунду назад. Сравнение по `received_at` вернуло бы его в очередь
    // немедленно — и второй разбор записал бы в портал второй комментарий.
    const вчера = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const id = await seed(вчера, new Date(), 'sending')

    const returned = await requeueStuck(15)

    expect(returned).toBe(0)
    expect(await statusOf(id)).toBe('sending')
  })

  it('забирает строку, брошенную умершим процессом', async () => {
    // Обратная сторона: без возврата один перезапуск в неудачный момент теряет ответ тихо —
    // в буфере он есть, а в портал не поедет никогда.
    const давно = new Date(Date.now() - 60 * 60 * 1000)
    const id = await seed(давно, давно, 'sending')

    expect(await requeueStuck(15)).toBe(1)
    expect(await statusOf(id)).toBe('pending')
  })

  it('не трогает строки, которые и так ждут своей очереди', async () => {
    const давно = new Date(Date.now() - 60 * 60 * 1000)
    const id = await seed(давно, давно, 'pending')

    expect(await requeueStuck(15)).toBe(0)
    expect(await statusOf(id)).toBe('pending')
  })
})
