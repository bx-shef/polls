// @ts-check
import tseslint from 'typescript-eslint'
import vueParser from 'vue-eslint-parser'

/**
 * Линт-гейт с ОДНОЙ задачей: ловить забытый `await` (#165).
 *
 * `tsc` ловит забытый `await` только в двух формах: при разыменовании результата (`inv?.context`,
 * `inv.token` → TS2339) и при ПОЛОЖИТЕЛЬНОЙ проверке истинности (`if (store.peek(t))` → TS2801).
 * Остальное он пропускает молча — проверено исполнением:
 *
 *   const inv = store.peek(token, now)
 *   if (!inv) return err(403)        // промис всегда истинен → 403 не сработает НИКОГДА,
 *                                    // а CRM-снимок уйдёт наружу для любого токена
 *   store.create(input, now)         // результат отброшен; с реализацией на БД реджект
 *                                    // станет unhandled rejection, а это падение процесса
 *
 * Это не гипотеза: сторы анти-абьюза переезжают на асинхронные порты (#4), и у `peek` боевой
 * вызывающий появится вместе с чтением `?token=` на странице опроса. Правила ниже — единственный
 * способ закрыть такие формы: они требуют ТИПОВ, грепом и `tsc` не заменяются.
 *
 * ⚠️ `recommended` ВКЛЮЧЁН — вопреки первой редакции этого файла, где было написано, что он «выдаст
 * сотни находок про стиль». Ревью замерило: на нашей базе `recommended` даёт **8** находок (шесть из
 * них — неиспользуемые имена с префиксом `_`, то есть принятая здесь конвенция). «Сотни» относились к
 * другому пресету — `recommendedTypeChecked` (209, из них 125 — тот самый `require-await`). Раз
 * настоящая цена оказалась в две правки, включаем: гейт шире и без выдуманного оправдания.
 * `strictTypeChecked` (572) и `stylistic` (46) по-прежнему вне набора.
 *
 * ⚠️ `require-await` НЕ включаем осознанно: `MemoryInvitationStore.create/peek/consume` объявлены
 * `async` без единого `await` внутри — и это правильно, они держат форму порта, за которым стоит
 * реализация на БД. Правило потребовало бы либо ломать порт, либо сыпать подавлениями.
 *
 * ⚠️ **Одна форма из #165 остаётся НЕ закрытой** — сравнение с `undefined` напрямую:
 *
 *   const found = store.peek(token, now)
 *   if (found === undefined) return err(403)   // промис никогда не `undefined`
 *
 * Её ловит только `@typescript-eslint/no-unnecessary-condition`, и он здесь отклонён по существу, а
 * не по объёму: на нашей базе он даёт 13 находок, и все — про «избыточную» защиту от `null` там, где
 * значение приходит из недоверенного ввода и типам не подчиняется. Включить его значило бы снимать
 * оборонительные проверки на границе — цена выше выигрыша. Форма остаётся на совести автора, зато
 * названа здесь, а не выдана за закрытую.
 */

/**
 * ⚠️ Проекты разведены по областям вручную, а не одним `projectService: true`.
 *
 * Причина в раскладке: корневой `tsconfig.json` включает только `src`/`test`/`scripts` — ядро
 * типизируется НЕЗАВИСИМО от Nuxt, и расширять его на `server`/`app` нельзя, это сломало бы смысл
 * `pnpm typecheck`. Конфиги для `server/` и `app/` генерирует Nuxt (`pnpm nuxt:prepare`, он и так
 * идёт в `pnpm check` перед `typecheck:app`).
 *
 * ⚠️ **Выпавшая отсюда область не даёт ошибки — она даёт тишину.** Ревью проверило исполнением: если
 * убрать строку `server/**`, то `eslint .` печатает пустой вывод и возвращает 0 **даже при настоящем
 * висячем промисе** в `server/` (файл просто «ignored because no matching configuration was
 * supplied»). То есть гейт выглядит настроенным и не проверяет половину серверного кода, ничем этого
 * не обнаруживая. Именно поэтому `test/lint-gate.test.ts` проверяет КАЖДУЮ область пробой, а не
 * читает этот список.
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
