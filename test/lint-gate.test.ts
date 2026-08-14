import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * Линт-гейт проверяется ИСПОЛНЕНИЕМ: запускаем настоящий ESLint на файле-приманке и смотрим, какие
 * правила он назвал.
 *
 * ⚠️ Почему не грепом по `eslint.config.mjs`. В этом проекте гарды, сверявшие ТЕКСТ конфигурации, а не
 * её поведение, проваливались трижды (#153, #159, #162): подстроку удовлетворяет и комментарий, и
 * объявление выше настоящего, и правило, выключенное ниже по цепочке конфигов. Здесь та же ловушка
 * особенно вероятна: типовые правила молча вырождаются в ничто, если файл не попал ни в один проект
 * TypeScript, — конфиг при этом выглядит правильным, а линт печатает «0 problems».
 *
 * Приманка (`fixtures/floating-promise.fixture.ts`) исключена из обычного `pnpm lint`, иначе валила бы
 * гейт всегда; снимаем исключение `--no-ignore`.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

const runEslint = (target: string) => spawnSync(
  'npx',
  ['eslint', '--no-ignore', '--format', 'json', target],
  { cwd: ROOT, encoding: 'utf8', timeout: 180_000 }
)

interface EslintMessage { ruleId: string | null }
interface EslintResult { messages: EslintMessage[] }

describe('линт-гейт забытого await (#165)', () => {
  const report = (() => {
    const r = runEslint('test/fixtures/floating-promise.fixture.ts')
    // ESLint отдаёт 1 при найденных ошибках и 2 при собственном сбое — их надо различать: сбой
    // конфигурации (например, файл вне проекта TypeScript) иначе читался бы как «правил нет».
    expect(r.status, `ESLint не смог отработать:\n${r.stderr}`).not.toBe(2)
    return JSON.parse(r.stdout) as EslintResult[]
  })()

  const rules = new Set(report.flatMap((f) => f.messages.map((m) => m.ruleId)))

  it('ловит промис, чей результат отброшен', () => {
    // Форма, которую `tsc` пропускает молча: с реализацией на БД это unhandled rejection, а на Node
    // это падение процесса — то есть телеметрия/стор роняют сервис, который обслуживают.
    expect(rules, `правила сработали: ${[...rules].join(', ') || '(ни одного)'}`)
      .toContain('@typescript-eslint/no-floating-promises')
  })

  it('ловит промис в булевом контексте — включая ОТРИЦАТЕЛЬНЫЙ гард', () => {
    // `if (!inv) return 403` на промисе всегда ложно. Для `peek` это значит, что «ссылка
    // недействительна» не сработает никогда, а CRM-снимок уйдёт наружу для любого токена.
    expect(rules).toContain('@typescript-eslint/no-misused-promises')
  })

  it('ловит await на не-промисе', () => {
    expect(rules).toContain('@typescript-eslint/await-thenable')
  })

  it('на боевом коде гейт ЗЕЛЁНЫЙ — иначе он не гейт, а шум', () => {
    // Проверяем сам предмет защиты: `src/api/invitation.ts` — порт, ради которого правила заводились.
    const r = runEslint('src/api/invitation.ts')
    expect(r.status, `боевой файл не проходит линт:\n${r.stdout}\n${r.stderr}`).toBe(0)
  })
})
