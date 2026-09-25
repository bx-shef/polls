import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { getDb, isDatabaseConfigured, schema } from '../../server/db/client'
import { healDegradedPortals, requeueStuckProvisioning } from '../../server/portals/heal'
import { PROVISION_STUCK_MINUTES } from '../../server/domain/portals/lifecycle'

/**
 * Долечивание порталов, застрявших в `degraded` (issue #12) — настоящим Postgres.
 *
 * ⚠ ПОД ЧТО ЗАВЕДЕНО. Установка сохраняет токены первой и обустраивает портал вторым шагом,
 * не роняя установку при неудаче. Неудача переводила портал в `degraded`, и на этом всё
 * кончалось: статус не читала НИ ОДНА строка кода. Администратор видел установленное
 * приложение, которое молча не работает, а единственным выходом была переустановка руками —
 * о необходимости которой ему никто не говорил.
 *
 * ⚠ ПОЧЕМУ НЕ ПОДДЕЛКОЙ БАЗЫ. Половина проверяемого здесь — гонка: захват портала должен
 * выигрывать ровно один исполнитель. Подделка подтвердит любой `where`; выигрыш одного
 * из двух `UPDATE` подтверждает только Postgres. Подделан здесь ПОРТАЛ (обустройство
 * приходит параметром), а не база, — то есть ровно наоборот к тому, как устроены юнит-тесты
 * обустройства.
 *
 * Без `DATABASE_URL` файл пропускает себя сам.
 */

const enabled = isDatabaseConfigured()

const TEST_DOMAIN = 'db-heal-test.bitrix24.ru'
const OTHER_DOMAIN = 'db-heal-other.bitrix24.ru'

const MINUTE = 60 * 1000

let portalId: string

async function makePortal(domain: string, status: string, updatedAt = new Date()): Promise<string> {
  const rows = await getDb()
    .insert(schema.portals)
    .values({ memberId: randomUUID(), domain, status, updatedAt })
    .returning({ id: schema.portals.id })
  return rows[0]!.id
}

async function statusOf(id: string): Promise<string> {
  const rows = await getDb()
    .select({ status: schema.portals.status })
    .from(schema.portals)
    .where(sql`${schema.portals.id} = ${id}`)
  return rows[0]!.status
}

async function wipe() {
  await getDb().execute(sql`delete from ${schema.portals} where domain in (${TEST_DOMAIN}, ${OTHER_DOMAIN})`)
}

/** Обустройство, которого не было: отвечает заданным исходом и считает обращения. */
function fakeProvision(outcome: 'ok' | 'not-admin' | 'no-scope' | 'failed' = 'ok') {
  const calls: string[] = []
  return {
    calls,
    attempt: async (portal: { domain: string }) => {
      calls.push(portal.domain)
      return outcome
    },
  }
}

describe.skipIf(!enabled)('долечивание порталов', () => {
  beforeEach(async () => {
    await wipe()
    portalId = await makePortal(TEST_DOMAIN, 'degraded')
  })

  afterAll(async () => {
    if (!enabled) return
    await wipe()
  })

  it('ГЛАВНОЕ: degraded перечитывается и лечится', async () => {
    // ⚠ То самое, чего не было вовсе: статус проставлялся и не читался никем.
    const portal = fakeProvision('ok')

    expect(await healDegradedPortals(new Date(), { portalId, provision: portal.attempt })).toBe(1)

    expect(portal.calls).toEqual([TEST_DOMAIN])
    expect(await statusOf(portalId)).toBe('active')
  })

  it('неудача возвращает портал в degraded, а не оставляет захваченным', async () => {
    // ⚠ Оставить `provisioning` значило бы завести новый способ застрять навсегда — ровно
    // тот же дефект, который здесь и чинится, только под другим именем.
    const portal = fakeProvision('not-admin')

    expect(await healDegradedPortals(new Date(), { portalId, provision: portal.attempt })).toBe(0)

    expect(await statusOf(portalId)).toBe('degraded')
  })

  it('исключение из обустройства — тоже degraded, а не захват навсегда', async () => {
    // Обустройство свои отказы разбирает исходом; сюда доходит то, что оно не поймало,
    // и портал обязан вернуться в очередь сам, не дожидаясь возврата брошенных.
    const boom = async () => {
      throw new Error('ECONNRESET')
    }

    expect(await healDegradedPortals(new Date(), { portalId, provision: boom })).toBe(0)

    expect(await statusOf(portalId)).toBe('degraded')
  })

  it('ГЛАВНОЕ: захват выигрывает ровно один', async () => {
    // ⚠ Это и есть блокировка, которую просил issue, — не в Redis по `member_id`, а в самой
    // таблице: `provisioning` и означает «портал взят». Проверяется изнутри обустройства:
    // пока первый лечит, второй не должен найти себе работы. Без условия `status =
    // 'degraded'` в самом `UPDATE` оба обустраивали бы один портал одновременно — то есть
    // 34–38 вызовов в чужой портал вместо 17–19, под общим бюджетом в 45 секунд.
    let second = -1
    const nested = async () => {
      second = await healDegradedPortals(new Date(), { portalId, provision: async () => 'ok' })
      return 'ok' as const
    }

    expect(await healDegradedPortals(new Date(), { portalId, provision: nested })).toBe(1)

    expect(second).toBe(0)
  })

  it('ГЛАВНОЕ: два ОДНОВРЕМЕННЫХ захвата — обустройство ровно одно', async () => {
    // ⚠ Предыдущий гвард проверяет последовательный случай: второй тик пришёл, пока первый
    // лечит. Этот — настоящую гонку, когда оба выбрали кандидата ДО того, как кто-то из них
    // записал захват. Разница не теоретическая: отбор кандидата и запись захвата — два
    // разных мгновения, и между ними помещается второй исполнитель.
    //
    // ⚠ Гвард держит СВОЙСТВО («обустройство ровно одно»), а не конкретную строку кода:
    // снятие внешнего условия `status = 'degraded'` из `UPDATE` он не ловит — проверено
    // обратной мутацией. Похоже, при повторной проверке Postgres переисполняет и подзапрос,
    // то есть защита есть и без дубля. Разбор — в шапке `heal.ts`; здесь это записано,
    // чтобы гвард не выглядел проверяющим больше, чем он проверяет.
    const seen: string[] = []
    const slow = async (portal: { domain: string }) => {
      seen.push(portal.domain)
      await new Promise(resolve => setTimeout(resolve, 50))
      return 'ok' as const
    }

    const [first, second] = await Promise.all([
      healDegradedPortals(new Date(), { portalId, provision: slow }),
      healDegradedPortals(new Date(), { portalId, provision: slow }),
    ])

    expect(seen).toHaveLength(1)
    expect(first + second).toBe(1)
  })

  it('портал с мёртвым грантом не берём', async () => {
    // Его токены нам уже не обменивают: обустройство упадёт на первом вызове, а в журнал
    // будет капать строка каждый час до самого стирания.
    await getDb().execute(
      sql`update ${schema.portals} set grant_revoked_at = now() where id = ${portalId}`,
    )
    const portal = fakeProvision('ok')

    expect(await healDegradedPortals(new Date(), { portalId, provision: portal.attempt })).toBe(0)

    expect(portal.calls).toEqual([])
  })

  it('здоровый портал не трогаем вовсе', async () => {
    const healthy = await makePortal(OTHER_DOMAIN, 'active')
    const portal = fakeProvision('ok')

    await healDegradedPortals(new Date(), { portalId: healthy, provision: portal.attempt })

    expect(portal.calls).toEqual([])
    expect(await statusOf(healthy)).toBe('active')
  })

  it('за заход берёт не больше потолка', async () => {
    // ⚠ Обустройство — 17–19 вызовов в чужой портал. Без потолка один тик на флоте
    // из сотни сломанных порталов выстрелил бы двумя тысячами вызовов подряд.
    await makePortal(OTHER_DOMAIN, 'degraded')
    const portal = fakeProvision('ok')

    expect(await healDegradedPortals(new Date(), { limit: 1, provision: portal.attempt })).toBe(1)

    expect(portal.calls).toHaveLength(1)
  })
})

describe.skipIf(!enabled)('возврат брошенного обустройства', () => {
  beforeEach(async () => {
    await wipe()
  })

  afterAll(async () => {
    if (!enabled) return
    await wipe()
  })

  it('ГЛАВНОЕ: портал, брошенный на середине, возвращается в очередь', async () => {
    // ⚠ Процесс умер между «взял» и «записал исход»: контейнер перезапустили, машину
    // выключили. Без возврата портал остался бы `provisioning` навсегда, и лечить его
    // было бы уже некому — захват берёт только `degraded`.
    const stale = new Date(Date.now() - (PROVISION_STUCK_MINUTES + 1) * MINUTE)
    const id = await makePortal(TEST_DOMAIN, 'provisioning', stale)

    expect(await requeueStuckProvisioning(new Date())).toBe(1)

    expect(await statusOf(id)).toBe('degraded')
  })

  it('идущее прямо сейчас обустройство НЕ отбирает', async () => {
    // Обратная цена ошибки: отобрав портал у живого обустройства, мы получили бы два
    // одновременных — то есть ровно то, от чего захват и защищает.
    const id = await makePortal(TEST_DOMAIN, 'provisioning', new Date())

    expect(await requeueStuckProvisioning(new Date())).toBe(0)

    expect(await statusOf(id)).toBe('provisioning')
  })

  it('переустановка во время лечения не перезаписывается исходом', async () => {
    // ⚠ Администратор переставил приложение, пока шло долечивание: свежие токены, статус
    // `active`. Записать поверх этого `degraded` по итогу устаревшей попытки значило бы
    // пометить сломанным портал, который только что встал заново. Закрывает
    // compare-and-swap по `provisioning`.
    const id = await makePortal(TEST_DOMAIN, 'degraded')
    const reinstallDuringHeal = async () => {
      await getDb().execute(sql`update ${schema.portals} set status = 'active' where id = ${id}`)
      return 'failed' as const
    }

    await healDegradedPortals(new Date(), { portalId: id, provision: reinstallDuringHeal })

    expect(await statusOf(id)).toBe('active')
  })
})
