import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Проводка присвоения портала (#171) — ИСПОЛНЯЕМЫЙ гард, а не греп по исходнику.
 *
 * ⚠️ Мутационный прогон показал, ради чего он нужен: убрать `adoptLocal` из боевой сборки опций —
 * и весь фикс #171 выключается, а все 1270 тестов остаются зелёными. Ядро присвоения покрыто, но
 * ядро зовёт себя само; в проде флаг ставит ровно одно место, и оно не исполнялось ничем.
 *
 * Мокается один модуль — драйвер `pg`: вместо сокета к Postgres пул ходит в pglite. Всё остальное —
 * настоящие `server/utils/api.ts` и `server/utils/portal.ts`: миграции, `ensureDefaultPortal`,
 * `PortalTokenStore` с боевыми хуками логирования.
 */
const pglite = new PGlite()
class FakePool {
  constructor(_o: unknown) {}
  on(): void {}
  async query(sql: string, params?: unknown[]) {
    if (params === undefined) { const r = await pglite.exec(sql); return r[r.length - 1] ?? { rows: [] } }
    return pglite.query(sql, params)
  }
  connect() {
    return Promise.resolve({ query: (s: string, p?: unknown[]) => pglite.query(s, p), release: () => {} })
  }
}
vi.mock('pg', () => ({ default: { Pool: FakePool }, Pool: FakePool }))

const KEY_HEX = 'a'.repeat(64)

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgres://fake/fake'
  process.env.NUXT_BITRIX_TOKEN_KEY = KEY_HEX
  const { applySchema } = await import('./helpers/schema')
  await applySchema(pglite)
})
afterAll(async () => {
  delete process.env.DATABASE_URL
  delete process.env.NUXT_BITRIX_TOKEN_KEY
  await pglite.close()
})

describe('проводка присвоения портала при установке', () => {
  it('боевые опции установки несут adoptLocal → плейсхолдер присваивается, второй строки нет', async () => {
    const { useStore } = await import('../server/utils/api')
    const { usePortalTokenStore } = await import('../server/utils/portal')
    const { installSaveOpts } = await import('../server/utils/install-opts')
    const { SURVEY_KEY, draftV2 } = await import('../src/demo/seed')

    // Инстанс поднялся до связки с Bitrix и накопил данные под плейсхолдером.
    const store = await useStore()
    if (!(await store.currentVersion(SURVEY_KEY))) await store.publish(draftV2(), 2)
    await store.addResponse({
      id: 'r-wiring',
      surveyKey: SURVEY_KEY,
      versionNo: 2,
      submittedAt: '2026-08-20T10:00:00.000Z',
      context: { dealId: 759, responsibleName: 'Иванов' },
      answers: []
    })
    const before = await pglite.query<{ n: number }>('select count(*)::int as n from response')
    expect(before.rows[0]!.n, 'нечего присваивать — данные не накопились').toBeGreaterThan(0)

    // Установка ТЕМИ ЖЕ опциями, что строит роут.
    const tokenStore = await usePortalTokenStore()
    expect(tokenStore, 'стор токенов не поднялся — тест ничего не проверит').toBeTruthy()
    const saved = await tokenStore!.save(
      {
        memberId: 'member-wiring-000000000000000',
        domain: 'acme.bitrix24.ru',
        accessToken: 'at',
        refreshToken: 'rt',
        expiresAt: '2026-08-20T11:00:00.000Z'
      },
      // ⚠️ НЕ `process.env.B24_EXPECTED_MEMBER_ID`: экспортированная в среде раннера переменная
      // молча переворачивала бы смысл теста (присвоение отказывало бы, тест падал бы «не там»).
      // Тест проверяет присвоение при НЕзаданном гейте — и говорит это явно.
      installSaveOpts(1_766_000_000, undefined)
    )
    expect(saved).toBe(true)

    const rows = await pglite.query<{ member_id: string }>('select member_id from portal order by id')
    expect(rows.rows.map((r) => r.member_id), 'установка завела ВТОРОЙ портал — данные разъехались')
      .toEqual(['member-wiring-000000000000000'])
    // И накопленное осталось на месте — присвоение, а не пересоздание.
    const after = await pglite.query<{ n: number }>('select count(*)::int as n from response')
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n)
  }, 60_000)
})

describe('гейт чужой установки стоит В РОУТЕ (#183)', () => {
  // Решение, лог инертности и чтение env — в исполняемо покрытой `installAccessGate`
  // (test/install-gate.test.ts): мутационный прогон показал, что регексы не видят исполнимости —
  // инверсия условия, потерянный `return` и опечатка env проходили полный `pnpm check`. Роуту
  // остались вызов и `return`; их держим регексом со СМЕЖНОСТЬЮ, которую эти мутации ломают.
  const src = readFileSync(resolve(process.cwd(), 'server/api/b24/install.post.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  it('гейт зовётся с authoritative member_id и БОЕВЫМ process.env', () => {
    // `process.env` целиком: имя переменной читает сама функция, и опечатка в нём ловится
    // исполнением, а не регексом по префиксу.
    expect(src, 'гейт снят с роута или отвязан от боевого окружения')
      .toMatch(/const gate = installAccessGate\(verifiedAuth\.memberId, process\.env, logger\)/)
  })

  it('отказ гейта НЕМЕДЛЕННО отвечает 403 и телом ошибки', () => {
    // Смежность `=== 'reject'` → … → `return html(event, gate.status, errorHtml(` в одном блоке:
    // инверсия (`!== 'reject'`) ломает первую скобку, потерянный `return` — вторую, подмена тела на
    // FINISH_HTML — третью.
    expect(src).toMatch(/if \(gate\.verdict === 'reject'\) \{[\s\S]{0,400}?return html\(event, gate\.status, errorHtml\(gate\.message\)\)/)
    expect(src, 'отказ проходит молча').toContain('b24_install_foreign_reject')
  })

  it('гейт стоит ПОСЛЕ верификации member_id и ДО сохранения токенов', () => {
    const gate = src.indexOf('installAccessGate(')
    expect(gate).toBeGreaterThan(-1)
    expect(gate, 'гейт стоит до верификации member_id — решает присланное значение')
      .toBeGreaterThan(src.indexOf('verifyInstallMember('))
    expect(gate, 'гейт стоит ПОСЛЕ сохранения — чужой тенант уже заведён')
      .toBeLessThan(src.indexOf('handleInstall('))
  })
})
