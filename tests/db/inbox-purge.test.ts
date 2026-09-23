import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { purgeExpiredAnswers } from '../../server/answers/deliver'
import { getDb, isDatabaseConfigured, schema } from '../../server/db/client'
import { PURGE_GRACE_DAYS } from '../../server/domain/portals/lifecycle'

/**
 * Предельный срок хранения сдавшихся ответов (issue #24, решение владельца 23.09).
 *
 * ⚠ Настоящим Postgres, а не подделкой, и по той же причине, что соседний `inbox-claim`:
 * здесь удаляются ПЕРСОНАЛЬНЫЕ ДАННЫЕ, и проверять надо не то, какой запрос мы собрали,
 * а что именно исчезло из таблицы и что в ней осталось. Мок подтвердил бы любую чушь,
 * а цена ошибки — стёртый ответ живого человека, которого никто не просил стирать.
 *
 * Без `DATABASE_URL` файл пропускает себя сам.
 */

const enabled = isDatabaseConfigured()

/**
 * ⚠ УБОРКА ЗОВЁТСЯ ТОЛЬКО ПО СВОЕМУ ПОРТАЛУ, и это не аккуратность, а исправление дефекта.
 * Первая редакция звала глобальную `purgeExpiredAnswers(now)` — и запуск `pnpm check`
 * с боевым `DATABASE_URL` НАВСЕГДА стирал истёкшие ответы ЧУЖИХ порталов. Воспроизведено
 * `/code-review` в PR #53: подсаженный ответ постороннего портала исчезал, а сам набор падал
 * на числе. Ровно тот дефект, который соседний `inbox-claim.test.ts` описывает как уже
 * случившийся однажды, — заведённый заново, только не через уборку, а через сам предмет
 * проверки. Заголовок файла при этом обещал обратное.
 */
function purgeOurs(now: Date, limit?: number) {
  return purgeExpiredAnswers(now, { limit, portalId })
}

/** Свой домен: чистим ТОЛЬКО его, а не таблицу — см. разбор в `inbox-claim.test.ts`. */
const TEST_DOMAIN = 'db-purge-test.bitrix24.ru'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Текст и ключ ответа — КОНСТАНТАМИ, и сверяется потом ровно они.
 *
 * ⚠ Первая редакция подсаживала «текст ответа живого человека», а проверяла отсутствие
 * «текстА ответа живого человека» — падежом мимо. Гвард под самый твёрдый инвариант проекта
 * не мог упасть в принципе: `/code-review` в PR #53 добавил настоящую утечку payload в журнал,
 * и тест остался зелёным. Ровно тот класс отказа, о котором предупреждает `CLAUDE.md`:
 * «все тесты зелёные при живой регрессии».
 */
const ANSWER_TEXT = 'текст ответа живого человека'
const ANSWER_KEY = 'q1'

let portalId: string

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS)
}

async function seed(receivedAt: Date, status: string, lastError = 'ACCESS_DENIED'): Promise<string> {
  const rows = await getDb()
    .insert(schema.inbox)
    .values({
      portalId,
      tokenHash: randomUUID(),
      // Тело намеренно непустое: проверяем, что оно исчезает вместе со строкой,
      // а не остаётся где-то ещё.
      payload: { answers: { [ANSWER_KEY]: ANSWER_TEXT } },
      receivedAt,
      nextAttemptAt: receivedAt,
      status,
      lastError,
    })
    .returning({ id: schema.inbox.id })
  return rows[0]!.id
}

async function alive(id: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: schema.inbox.id })
    .from(schema.inbox)
    .where(sql`${schema.inbox.id} = ${id}`)
  return rows.length === 1
}

async function wipe() {
  await getDb().execute(sql`delete from ${schema.portals} where domain = ${TEST_DOMAIN}`)
}

describe.skipIf(!enabled)('срок хранения сдавшихся ответов', () => {
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

  it('стирает сдавшийся ответ, пролежавший дольше срока', async () => {
    const id = await seed(daysAgo(PURGE_GRACE_DAYS + 1), 'failed')

    expect(await purgeOurs(new Date())).toBe(1)
    expect(await alive(id)).toBe(false)
  })

  it('НЕ стирает сдавшийся ответ, у которого срок ещё не вышел', async () => {
    // ⚠ Правильная сторона ошибки: лишний день хранения — неаккуратность, лишний день
    // раньше — стёртый ответ, который ещё можно было доставить.
    const id = await seed(daysAgo(PURGE_GRACE_DAYS - 1), 'failed')

    expect(await purgeOurs(new Date())).toBe(0)
    expect(await alive(id)).toBe(true)
  })

  it.each([['pending'], ['sending']])('НЕ трогает %s, даже пролежавший годами', async (status) => {
    // ⚠ ГЛАВНЫЙ ГВАРД ФАЙЛА. Без условия по статусу под удаление попало бы всё, что старше
    // срока: `pending`, который ждёт недоступного портала, и `sending`, который воркер
    // держит прямо сейчас. То есть уборщик, заведённый ради инварианта «не хранить дольше
    // нужного», нарушал бы инвариант «ответ не теряется никогда».
    const id = await seed(daysAgo(365), status)

    expect(await purgeOurs(new Date())).toBe(0)
    expect(await alive(id)).toBe(true)
  })

  it('уносит тело ответа вместе со строкой, а не оставляет его', async () => {
    await seed(daysAgo(PURGE_GRACE_DAYS + 1), 'failed')
    await purgeOurs(new Date())

    const left = await getDb().execute(
      sql`select count(*)::int as n from ${schema.inbox} where portal_id = ${portalId}`,
    )
    expect((left as unknown as { n: number }[])[0]!.n).toBe(0)
  })

  it('за один заход стирает не больше потолка, начиная с самых давних', async () => {
    // ⚠ Потолок — не про скорость, а про предел ущерба: ошибка в часах или в границе
    // без него унесла бы весь буфер ОДНИМ запросом. С ним беда идёт порциями, каждая
    // со своими строками в журнале, и заметна задолго до того, как станет непоправимой.
    const старый = await seed(daysAgo(100), 'failed')
    const свежий = await seed(daysAgo(PURGE_GRACE_DAYS + 1), 'failed')

    expect(await purgeOurs(new Date(), 1)).toBe(1)
    expect(await alive(старый)).toBe(false)
    expect(await alive(свежий)).toBe(true)
  })

  it('пишет факт удаления, но НЕ текст ответа', async () => {
    // ⚠ Решение владельца: «удалять с записью факта в журнал без содержимого». Это то,
    // что спросят при разборе «а куда делся ответ», и единственный способ ответить,
    // ничего не храня. Инвариант «не логировать текст ответа» при этом в силе.
    const { logger } = await import('../../server/utils/logger')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger)

    await seed(daysAgo(PURGE_GRACE_DAYS + 1), 'failed')
    await purgeOurs(new Date())

    const written = JSON.stringify(warn.mock.calls)
    const warnArgs = warn.mock.calls[0]!
    warn.mockRestore()

    expect(written).toContain('стёрт по истечении срока')
    expect(written).toContain('ACCESS_DENIED')
    // ⚠ ДОМЕН, а не внутренний идентификатор: после удаления строки журнал — это всё,
    // что осталось, и `uuid` не отвечает на вопрос «а куда делся ответ» без похода в базу.
    expect(written).toContain(TEST_DOMAIN)
    // ⚠ Сверяется РОВНО то, что подсадили, а не похожая строка.
    expect(written).not.toContain(ANSWER_TEXT)
    expect(written).not.toContain(ANSWER_KEY)
    // ⚠ И состав ключей — целиком. Без этого утечка под новым именем поля прошла бы мимо
    // обеих проверок выше: они знают, чего быть НЕ должно, а этот знает, что должно.
    expect(Object.keys(warnArgs[0] as object).sort()).toEqual(['domain', 'reason', 'receivedAt'])
  })

  it('срок хранения ответов — ровно тридцать суток, как решил владелец', () => {
    // ⚠ Все проверки выше выражены через `PURGE_GRACE_DAYS`, то есть переживут его правку.
    // А правят его по СОВСЕМ другой причине — там речь про отсрочку мёртвого портала, —
    // и срок хранения персональных данных молча уехал бы следом. Одна буквальная сверка
    // делает связку честной: меняешь — видишь. Нашёл `/code-review` в PR #53.
    expect(PURGE_GRACE_DAYS).toBe(30)
  })

  it('на пустом буфере ничего не делает и молчит', async () => {
    // Предупреждение, которое звучит всегда, перестают читать.
    const { logger } = await import('../../server/utils/logger')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger)

    expect(await purgeOurs(new Date())).toBe(0)
    const calls = warn.mock.calls.length
    warn.mockRestore()

    expect(calls).toBe(0)
  })
})
