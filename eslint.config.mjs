// @ts-check
import tseslint from 'typescript-eslint'
import vueParser from 'vue-eslint-parser'

/**
 * Линт-политика проекта. Поводом была одна дыра (#165), но набор шире одного правила — см. ниже.
 *
 * **Зачем вообще.** `tsc` ловит забытый `await` в двух формах: при разыменовании результата
 * (`inv?.context` → TS2339) и при положительной проверке истинности (`if (store.peek(t))` → TS2801).
 * Остальное проходит молча:
 *
 *   const inv = store.peek(token, now)
 *   if (!inv) return err(403)   // промис всегда истинен → 403 не сработает НИКОГДА,
 *                               // а CRM-снимок уйдёт наружу для любого токена
 *   store.create(input, now)    // отброшен; у реализации на БД реджект станет
 *                               // unhandled rejection, то есть падением процесса
 *
 * Сторы анти-абьюза переезжают на асинхронные порты (#4), и у `peek` боевой вызывающий появится
 * вместе с чтением `?token=` на странице опроса. Эти правила требуют ТИПОВ — грепом и `tsc` не
 * заменяются.
 *
 * **Что включено:** `recommended` (~30 правил) + три типовых правила про промисы + `no-control-regex`.
 * **Что нет и почему:**
 *  - `require-await` — `MemoryInvitationStore` объявляет методы `async` без `await` внутри, и это
 *    правильно: они держат форму порта, за которым стоит реализация на БД. Правило потребовало бы
 *    либо ломать порт, либо сыпать подавлениями (125 находок из 209 у `recommendedTypeChecked`).
 *  - `no-unnecessary-condition` — 13 находок, все про «избыточную» защиту от `null` там, где значение
 *    приходит из недоверенного ввода. Включить значило бы снимать оборонительные проверки на границе.
 *    Ценой остаётся незакрытая форма `found === undefined` — единственная из #165, которую не ловит
 *    ни одно включённое правило.
 *  - `strictTypeChecked` (572 находки) и `stylistic` (46) — вне набора.
 */

/**
 * Проекты TypeScript привязаны к областям вручную: корневой `tsconfig.json` включает только
 * `src`/`test`/`scripts` (ядро типизируется независимо от Nuxt), конфиги для `server/`, `app/` и
 * `shared/` генерирует `nuxt prepare`, а корневые конфиги сборки и бутстрап телеметрии не входят
 * никуда — им заведён `tsconfig.tooling.json`. `projectService` этот расклад не берёт (38 ошибок),
 * `allowDefaultProject` каталоги не принимает принципиально.
 *
 * ⚠️ **Выпавшая отсюда область не даёт ошибки — она даёт тишину.** Файл, не совпавший ни с одним
 * `files`, ESLint пропускает без слова и с кодом 0, даже если в нём висячий промис. Отсутствие
 * сгенерированных конфигов, наоборот, падает громко. Тишину ловит `test/lint-gate.test.ts` сверкой
 * списков — не читая этот массив.
 */
const AREAS = [
  { files: ['src/**/*.{ts,mts,cts}', 'test/**/*.{ts,mts,cts}', 'scripts/**/*.{ts,mts,cts}'], project: './tsconfig.json' },
  // Приманка гейта: исключена из корневого tsconfig, поэтому проект у неё свой.
  { files: ['test/fixtures/**/*.{ts,mts,cts}'], project: './test/fixtures/tsconfig.json' },
  { files: ['server/**/*.{ts,mts,cts}'], project: './.nuxt/tsconfig.server.json' },
  { files: ['app/**/*.{ts,mts,cts}'], project: './.nuxt/tsconfig.app.json' },
  // Общий слой Nuxt 4 (`shared/`): каталога пока нет, но `nuxt prepare` уже генерирует под него
  // конфиг, а `typecheck:app` его типизирует. Без строки код, положенный туда завтра, выпал бы из
  // линта беззвучно — гард покрытия ниже это ловит, но лучше не доводить.
  { files: ['shared/**/*.{ts,mts,cts}'], project: './.nuxt/tsconfig.shared.json' },
  // Корневые конфиги и бутстрап телеметрии — см. `tsconfig.tooling.json`.
  { files: ['*.config.ts', '*.config.mjs', 'otel.instrument.mjs', 'scripts/**/*.mjs'], project: './tsconfig.tooling.json' }
]

/** @type {import('typescript-eslint').ConfigWithExtends['rules']} */
const rules = {
  // Обещание, за которым никто не следит: результат отброшен, ошибка не поймана.
  '@typescript-eslint/no-floating-promises': 'error',
  // `await` на не-промисе (след слепой замены) и — важнее — промис там, где ждали значение.
  '@typescript-eslint/await-thenable': 'error',
  // Промис в булевом контексте (`if (store.peek(...))`), async-колбэк там, где ждут синхронный.
  '@typescript-eslint/no-misused-promises': 'error',
  // Единственное правило вне темы промисов, и оно здесь не случайно: в проекте есть отдельный гард на
  // отсутствие БУКВАЛЬНЫХ невидимых символов в исходниках (Trojan-Source), а `src/domain/text.ts` уже
  // нёс `eslint-disable-next-line no-control-regex` — написанный вслепую, потому что линта не было.
  // Включаем, чтобы подавление стало осмысленным, а не висело мёртвой строкой.
  'no-control-regex': 'error',
  // Конвенция проекта «префикс `_` = намеренно не используется» — иначе `recommended` спорит с ней.
  '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
}

export default tseslint.config(
  {
    /**
     * ⚠️ Мёртвое подавление — ОШИБКА, а не предупреждение.
     *
     * По умолчанию это warning, а `eslint .` шёл без `--max-warnings=0`: любое предупреждение
     * никогда не уронило бы CI. Мёртвая директива — типичный симптом того, что правило отключили выше
     * по цепочке, то есть ровно того, что гейт обязан замечать. Плюс это делает бессмысленным
     * «подавить на всякий случай»: лишняя строка теперь красная.
     */
    linterOptions: { reportUnusedDisableDirectives: 'error' }
  },
  {
    // Вендорный бандл отчётности и легаси линтом не покрываются (правило проекта);
    // сборочные артефакты и эталоны скриншотов — тем более.
    ignores: [
      'reporting-kit/**', '.nuxt/**', '.output/**', 'dist/**', 'coverage/**',
      'node_modules/**', 'test-results/**', '**/__screenshots__/**', 'otel-preload-package.json',
      // Приманка линт-гейта: нарушает правила НАМЕРЕННО. Снимается флагом `--no-ignore`
      // в `test/lint-gate.test.ts`, который на ней и проверяет, что правила срабатывают.
      'test/fixtures/**'
    ]
  },
  ...AREAS.map(({ files, project }) => ({
    files,
    extends: [tseslint.configs.recommended],
    languageOptions: { parserOptions: { project, tsconfigRootDir: import.meta.dirname } },
    rules
  })),
  {
    // `.vue` разбирает vue-eslint-parser, а `<script>` внутри — парсер TypeScript; без этого
    // типовые правила до содержимого компонентов не добираются вовсе.
    files: ['app/**/*.vue'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        project: './.nuxt/tsconfig.app.json',
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.vue']
      }
    },
    rules
  }
)
