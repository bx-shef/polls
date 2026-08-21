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
 *    либо ломать порт, либо сыпать подавлениями; на нашей базе оно же даёт большинство находок
 *    пресета `recommendedTypeChecked`.
 *  - `no-unnecessary-condition` — около десятка находок: часть про оборонительные проверки от `null`
 *    там, где значение приходит из недоверенного ввода и типам не подчиняется, часть про сужения,
 *    которые типы считают избыточными. Включить значило бы снимать защиту на границе. Ценой остаётся
 *    незакрытая форма `found === undefined`.
 *
 * **Что остаётся незакрытым — названо, а не умолчано:**
 *  - `found === undefined` (сравнение вместо истинности);
 *  - `const _x = store.save(v)` — присвоение в неиспользуемую переменную с префиксом `_`, который мы
 *    сами разрешили конвенцией. Однознаковый обход; штатный способ погасить промис — `void`;
 *  - выражения в **шаблоне** `.vue` (`@click="save()"`): `vue-eslint-parser` их отдаёт, но
 *    `parserServices` для template-AST нет, поэтому типовые правила туда не доходят. Формы уже есть
 *    в коде (`FeedbackWidget.vue`, экраны `/admin/*`).
 *  - `strictTypeChecked` и `stylistic` — вне набора.
 *
 * ⚠️ Точных счётчиков находок здесь намеренно НЕТ. Они уже устаревали дважды: этот же PR расширил
 * охват линта (`tsconfig.tooling.json` втянул бутстрап телеметрии и mjs-скрипты), и все ранее
 * записанные цифры разъехались на треть. Причина отказа устойчива, счётчик — нет; замеры места
 * и даты живут в теле PR.
 */

/**
 * Проекты TypeScript привязаны к областям вручную: корневой `tsconfig.json` включает только
 * `src`/`test`/`scripts` (ядро типизируется независимо от Nuxt), конфиги для `server/`, `app/` и
 * `shared/` генерирует `nuxt prepare`, а корневые конфиги сборки и бутстрап телеметрии не входят
 * никуда — им заведён `tsconfig.tooling.json`. `projectService` этот расклад не берёт (все файлы
 * `server/`/`app/` падают с «was not found by the project service»), а `allowDefaultProject` каталоги
 * не принимает принципиально — отвергает glob с `**`.
 *
 * ⚠️ **Выпавшая отсюда область не даёт ошибки — она даёт тишину.** Файл, не совпавший ни с одним
 * `files`, ESLint пропускает без слова и с кодом 0, даже если в нём висячий промис. Отсутствие
 * сгенерированных конфигов, наоборот, падает громко. Тишину ловит `test/lint-gate.test.ts` сверкой
 * списков — не читая этот массив.
 */
const AREAS = [
  { files: ['src/**', 'test/**', 'scripts/**'], project: './tsconfig.json' },
  // Приманка гейта: исключена из корневого tsconfig, поэтому проект у неё свой.
  { files: ['test/fixtures/**'], project: './test/fixtures/tsconfig.json' },
  { files: ['server/**'], project: './.nuxt/tsconfig.server.json' },
  // Тесты проводки приглашений загружают модули Nitro (авто-импорты Nuxt), поэтому исключены из
  // ядрового проекта — и им нужен свой, иначе типовые правила по ним молча выключатся.
  {
    files: ['test/invitation-retention.test.ts', 'test/invitation-wiring.test.ts', 'test/install-wiring.test.ts', 'test/close-invite.test.ts', 'test/close-invite-wiring.test.ts', 'test/tenant-wiring.test.ts', 'test/demo-seed-wiring.test.ts'],
    project: './test/nitro-tsconfig.json'
  },
  { files: ['app/**'], project: './.nuxt/tsconfig.app.json' },
  // Общий слой Nuxt 4 (`shared/`): каталога пока нет, но `nuxt prepare` уже генерирует под него
  // конфиг, а `typecheck:app` его типизирует. Без строки код, положенный туда завтра, линтовался бы
  // без типов — то есть громко, но зря.
  { files: ['shared/**'], project: './.nuxt/tsconfig.shared.json' },
  // ⚠️ `nuxt.config.ts` — отдельно: ядровой tsconfig framework-agnostic и `defineNuxtConfig` в нём не
  // резолвится, отчего весь файл деградировал бы в `any`, а типовые правила по нему молчали бы, не
  // сказав ни слова. У Nuxt для этого случая есть свой сгенерированный проект.
  { files: ['nuxt.config.ts'], project: './.nuxt/tsconfig.node.json' },
  // Остальные корневые конфиги и бутстрап телеметрии — см. `tsconfig.tooling.json`.
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
     * ⚠️ Мёртвое подавление — ОШИБКА, а не предупреждение (по умолчанию это warning).
     *
     * Мёртвая директива — типичный симптом того, что правило отключили выше по цепочке, то есть ровно
     * того, что гейт обязан замечать. Плюс это делает бессмысленным «подавить на всякий случай»:
     * лишняя строка теперь красная. Второй замок на ту же дверь — `--max-warnings=0` в скрипте
     * `lint`; порознь каждый из них обходится, вместе — нет.
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
  {
    // ⚠️ Правила — ОДНИМ слоем на всё дерево, а области ниже задают только привязку к проекту
    // TypeScript. Это и есть починка тихого пропуска: раньше правила висели внутри областей, и файл,
    // не совпавший ни с одной, проходил БЕЗ СЛОВА и с кодом 0, даже с висячим промисом. Теперь такой
    // файл получает правила, но не получает типов — и линт падает с кодом 2, называя файл поимённо.
    // Гард `test/lint-gate.test.ts` остаётся, но как бэкстоп, а не единственная линия обороны.
    files: ['**/*.{ts,mts,cts,tsx,mjs,cjs,js,jsx,vue}'],
    extends: [tseslint.configs.recommended],
    languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } },
    rules
  },
  {
    // `.vue` разбирает vue-eslint-parser, а `<script>` внутри — парсер TypeScript; без этого типовые
    // правила до содержимого компонентов не добираются вовсе.
    // ⚠️ До ВЫРАЖЕНИЙ В ШАБЛОНЕ они не добираются и так: `parserServices` для template-AST нет, то
    // есть `@click="save()"` с висячим промисом не ловится. Это названо в шапке среди незакрытых форм.
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] }
    }
  },
  ...AREAS.map(({ files, project }) => ({
    files,
    languageOptions: { parserOptions: { project, tsconfigRootDir: import.meta.dirname } }
  }))
)
