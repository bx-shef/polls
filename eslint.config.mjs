// @ts-check
import tseslint from 'typescript-eslint'
import vueParser from 'vue-eslint-parser'

/**
 * Линт-гейт с ОДНОЙ задачей: ловить забытый `await` (#165).
 *
 * ⚠️ Почему набор правил узкий, а не «recommended». Гейт заводится ради конкретной дыры, а не ради
 * стиля: `tsc` ловит забытый `await` ТОЛЬКО там, где результат сразу разыменовывают (`inv?.context`,
 * `inv.token`). Формы без разыменования он пропускает молча — проверено исполнением:
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
 * Широкий `recommended` намеренно НЕ включён: на кодовой базе такого размера он выдаст сотни находок
 * про стиль, разбирать их вперемешку с переездом сторов — верный способ спрятать и то, и другое.
 * Расширение набора — отдельной задачей, когда этот гейт устоится.
 *
 * ⚠️ `require-await` НЕ включаем осознанно: `MemoryInvitationStore.create/peek/consume` объявлены
 * `async` без единого `await` внутри — и это правильно, они держат форму порта, за которым стоит
 * реализация на БД. Правило потребовало бы либо ломать порт, либо сыпать подавлениями.
 */

/**
 * ⚠️ Проекты разведены по областям вручную, а не одним `projectService: true`.
 *
 * Причина в раскладке: корневой `tsconfig.json` включает только `src`/`test`/`scripts` — ядро
 * типизируется НЕЗАВИСИМО от Nuxt, и расширять его на `server`/`app` нельзя, это сломало бы смысл
 * `pnpm typecheck`. Конфиги для `server/` и `app/` генерирует Nuxt (`pnpm nuxt:prepare`, он и так
 * идёт в `pnpm check` перед `typecheck:app`). Без явной привязки типовые правила по этим каталогам
 * не работают вовсе — линт падает с «was not found by the project service», то есть гейт выглядел бы
 * настроенным, а половину серверного кода не проверял.
 */
const AREAS = [
  { files: ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts'], project: './tsconfig.json' },
  // Приманка гейта: исключена из корневого tsconfig, поэтому проект у неё свой.
  { files: ['test/fixtures/**/*.ts'], project: './test/fixtures/tsconfig.json' },
  { files: ['server/**/*.ts'], project: './.nuxt/tsconfig.server.json' },
  { files: ['app/**/*.ts'], project: './.nuxt/tsconfig.app.json' }
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
  'no-control-regex': 'error'
}

export default tseslint.config(
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
    extends: [tseslint.configs.base],
    languageOptions: { parserOptions: { project, tsconfigRootDir: import.meta.dirname } },
    rules
  })),
  {
    // `.vue` разбирает vue-eslint-parser, а `<script>` внутри — парсер TypeScript; без этого
    // типовые правила до содержимого компонентов не добираются вовсе.
    files: ['app/**/*.vue'],
    extends: [tseslint.configs.base],
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
  },
  {
    // Корневые конфиги сборки и бутстрап телеметрии: ни в один tsconfig не входят, а бутстрап вдобавок
    // чистый JS без деклараций. Типовые правила к ним неприменимы — не делаем вид, что применимы.
    files: ['*.config.ts', '*.config.mjs', 'otel.instrument.mjs'],
    extends: [tseslint.configs.disableTypeChecked]
  }
)
