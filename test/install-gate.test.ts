import { describe, expect, it, vi } from 'vitest'
import { installAccessGate } from '../server/utils/install-gate'

/**
 * Гейт чужой установки — ИСПОЛНЯЕМО (#183, после мутационного прогона на ревью).
 *
 * ⚠️ Пока гейт жил телом роута, три мутации проходили полный `pnpm check`: инверсия условия,
 * потерянный `return`, опечатка в имени env-переменной (регекс матчился по префиксу). Все три
 * ловятся здесь исполнением; роуту остались вызов и `return` под регексом со смежностью.
 */
const log = () => {
  const lines: Array<[string, Record<string, unknown>]> = []
  return { error: vi.fn((e: string, f: Record<string, unknown>) => { lines.push([e, f]) }), lines }
}
const OWN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

describe('installAccessGate', () => {
  it('single: свой портал проходит, чужой получает РОВНО 403-отказ', () => {
    const env = { B24_EXPECTED_MEMBER_ID: OWN, B24_PORTAL_MODE: 'single' }
    expect(installAccessGate(OWN, env, log())).toEqual({ verdict: 'allow' })
    const rejected = installAccessGate('f'.repeat(32), env, log())
    // Форма отказа целиком: инверсия условия в роуте (`allow` ↔ `reject`) и подмена статуса ловятся
    // сравнением объекта, а текст не называет ожидаемый портал.
    expect(rejected).toEqual({ verdict: 'reject', status: 403, message: 'этот сервер обслуживает другой портал Bitrix24' })
    expect(JSON.stringify(rejected)).not.toContain(OWN)
  })

  it('ИМЯ переменной читается из env-объекта — опечатка ловится исполнением', () => {
    // ⚠️ Регекс по роуту матчился по префиксу (`B24_EXPECTED_MEMBER_ID_LEGACY` проходил). Здесь env —
    // объект с ровно тем ключом, который обязан читаться: чтение другого имени вернёт `allow` чужому.
    const rejected = installAccessGate('f'.repeat(32), { B24_EXPECTED_MEMBER_ID: OWN }, log())
    expect(rejected.verdict, 'переменная прочитана не под тем именем — гейт пуст').toBe('reject')
  })

  it('multi: чужая установка легитимна', () => {
    expect(installAccessGate('f'.repeat(32), { B24_EXPECTED_MEMBER_ID: OWN, B24_PORTAL_MODE: 'multi' }, log()))
      .toEqual({ verdict: 'allow' })
  })

  it('переменной нет В ПРОДЕ → пускаем, но кричим error в момент прохода', () => {
    // env-check доказывает содержимое файла, но не то, что контейнер его получил, — ровно так гейт
    // присвоения #171 не работал на прод-compose при зелёном предполёте.
    const l = log()
    expect(installAccessGate(OWN, { NODE_ENV: 'production' }, l).verdict).toBe('allow')
    expect(l.error).toHaveBeenCalledTimes(1)
    expect(l.lines[0]?.[0]).toBe('b24_install_gate_inert')
  })

  it('переменной нет вне прода (dev/тесты) → пускаем МОЛЧА', () => {
    const l = log()
    expect(installAccessGate(OWN, {}, l).verdict).toBe('allow')
    expect(l.error).not.toHaveBeenCalled()
  })

  it('заданная переменная не даёт строки инертности — даже на чужом портале', () => {
    const l = log()
    installAccessGate('f'.repeat(32), { B24_EXPECTED_MEMBER_ID: OWN, NODE_ENV: 'production' }, l)
    expect(l.error).not.toHaveBeenCalled()
  })

  it('префикс своего member_id — НЕ свой', () => {
    // Мутация `===` → `startsWith` выживала: пары в прежних тестах различались целиком.
    const rejected = installAccessGate(OWN + '00', { B24_EXPECTED_MEMBER_ID: OWN }, log())
    expect(rejected.verdict).toBe('reject')
  })

  it('регистр режима: MULTI — это НЕ multi, гейт остаётся single', () => {
    // Согласовано с env-check: он на `MULTI` даёт ошибку, а рантайм обязан упасть в строгий режим.
    const rejected = installAccessGate('f'.repeat(32), { B24_EXPECTED_MEMBER_ID: OWN, B24_PORTAL_MODE: 'MULTI' }, log())
    expect(rejected.verdict, 'верхний регистр молча открыл установку всем').toBe('reject')
  })
})
