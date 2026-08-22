<script setup lang="ts">
// Лендинг (публичная витрина). ВСЕ продающие тексты — из `app/utils/landing.ts`, включая заголовки
// секций и блок приватности: те же константы кормят обложку для соцсетей, а тест `landing.test.ts`
// сканирует файл на обещания, которых в продукте ещё нет. Инлайн-строк в шаблоне быть не должно —
// первая версия держала их здесь, и мимо правки проехали ровно самые сильные утверждения.
// Правка заголовка/описания/метрик требует `pnpm og`.
//
// Компоненты — b24ui на air-токенах (`B24Container`/`B24PageCard`/`B24Badge`/`B24Button`/
// `B24Separator`/`B24Link`), поэтому светлая и тёмная темы работают из коробки, хардкод-цветов нет.
// Сетка и заголовки секций — обычные Tailwind-классы, как на дашборде: у `B24PageGrid`/`B24PageSection`
// свои колонки и щедрые отступы на старших брейкпоинтах, они перебивали заданные здесь — на рендере
// колонки не раскладывались, а между секциями зияли пустоты в пол-экрана (увидено на скриншоте).
//
// ⚠️ Два решения приняты ПРОТИВ образца соседнего проекта, оба сознательно:
//  1. **без анимаций и QR** — иначе страницу нельзя было бы поставить под визуальный гейт
//     (снимок «плывёт»), а лендинг — единственный экран, который увидит покупатель;
//  2. **тёмная тема НЕ пиннится** — у соседа лендинг зафиксирован тёмным, и это разошлось бы с
//     токенами b24ui на остальных страницах: человек, пришедший с лендинга в приложение, увидел бы
//     смену темы на ровном месте.
// ⚠️ Заголовкам цвет задаётся ЯВНО (`text-gray-900 dark:text-white`), как на дашборде. Без этого они
// наследуют тёмный цвет и в тёмной теме исчезают: на первом рендере H1 и все H2 были не видны вовсе,
// хотя карточки b24ui (со своими токенами) рисовались нормально — то есть страница выглядела «почти
// рабочей». Голый `<h1>`/`<h2>` без цвета на этой странице не оставлять.
const demoSurvey = `/s/${LANDING_DEMO_SURVEY}`
// `new URL(...).host` вместо срезания префикса строкой: не ломается на слеше или смене схемы.
const siteHost = new URL(LANDING_SITE_URL).host

// Обложка 1200×630 (`scripts/lib/ogTemplate.mjs`). Размеры и alt указываем явно: без них первая
// отправка ссылки часто уходит без картинки — краулер только ставит её в очередь на загрузку.
const OG_IMAGE = `${LANDING_SITE_URL}/og.png`
useSeoMeta({
  title: LANDING_TITLE,
  description: LANDING_DESCRIPTION,
  ogSiteName: LANDING_TITLE,
  ogLocale: 'ru_RU',
  ogTitle: LANDING_TITLE,
  ogDescription: LANDING_DESCRIPTION,
  ogType: 'website',
  ogUrl: LANDING_SITE_URL,
  ogImage: OG_IMAGE,
  ogImageWidth: 1200,
  ogImageHeight: 630,
  ogImageAlt: LANDING_TITLE,
  twitterCard: 'summary_large_image',
  twitterImage: OG_IMAGE
})
useHead({ link: [{ rel: 'canonical', href: LANDING_SITE_URL }] })
</script>

<template>
  <main>
    <!-- Герой -->
    <B24Container class="py-16 sm:py-24">
      <div class="flex flex-col items-center gap-6 text-center">
        <B24Badge color="air-secondary-accent" size="md" label="Приложение для Bitrix24" />
        <!-- Статус — ДО списка возможностей: страница уезжает на живой домен раньше, чем приложение
             появится в Маркете, и ни одна фраза ниже не должна читаться как гарантия отгруженного. -->
        <B24Alert
          v-if="!MARKET_PUBLISHED"
          color="air-primary-warning"
          :title="LANDING_STATUS"
          description="Сервис работает и открыт для демонстрации: попробуйте опрос по кнопке ниже."
          class="max-w-xl text-left"
        />
        <h1 class="max-w-3xl text-4xl font-bold tracking-tight text-gray-900 sm:text-5xl dark:text-white">
          {{ LANDING_TITLE }}
        </h1>
        <p class="max-w-2xl text-lg text-gray-700 dark:text-gray-300">
          {{ LANDING_SUBTITLE }}
        </p>

        <ul class="flex flex-wrap justify-center gap-2">
          <li v-for="m in LANDING_METRICS" :key="m">
            <B24Badge color="air-tertiary" size="md" :label="m" />
          </li>
        </ul>

        <div class="flex flex-col items-center gap-3 sm:flex-row">
          <!-- Именно `to`, а не `@click`: `@click` рендерит <button> без href — краулер не пройдёт
               по единственному целевому действию страницы, а человек не откроет его в новой вкладке
               и не скопирует адрес. Клиентская навигация при этом сохраняется. -->
          <B24Button color="air-primary" size="lg" label="Посмотреть демо-опрос" :to="demoSurvey" />
          <!-- Кнопка Маркета появится в день публикации: ссылка на незанятый слаг вела бы на 404. -->
          <B24Button
            v-if="MARKET_PUBLISHED"
            color="air-secondary"
            size="lg"
            label="Установить из Маркета"
            :to="marketUrl()"
            target="_blank"
          />
        </div>
      </div>
    </B24Container>

    <B24Separator />

    <!-- Боль → результат -->
    <B24Container class="py-12 sm:py-16">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <B24PageCard title="Как обычно бывает" :description="LANDING_PAIN_RESULT.before" />
        <B24PageCard highlight title="Как становится" :description="LANDING_PAIN_RESULT.after" />
      </div>
    </B24Container>

    <!-- Три шага -->
    <B24Container class="py-12 sm:py-16">
      <div class="mb-8 text-center">
        <p class="text-sm font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">{{ LANDING_SECTIONS.steps.kicker }}</p>
        <h2 class="mt-2 text-3xl font-bold tracking-tight text-gray-900 dark:text-white">{{ LANDING_SECTIONS.steps.title }}</h2>
        <p class="mt-3 text-gray-700 dark:text-gray-300">{{ LANDING_SECTIONS.steps.lead }}</p>
      </div>
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <B24PageCard
          v-for="s in LANDING_STEPS"
          :key="s.n"
          :title="`${s.n}. ${s.title}`"
          :description="s.text"
        />
      </div>
    </B24Container>

    <!-- Возможности -->
    <B24Container class="py-12 sm:py-16">
      <div class="mb-8 text-center">
        <p class="text-sm font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">{{ LANDING_SECTIONS.features.kicker }}</p>
        <h2 class="mt-2 text-3xl font-bold tracking-tight text-gray-900 dark:text-white">{{ LANDING_SECTIONS.features.title }}</h2>
      </div>
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <B24PageCard
          v-for="f in LANDING_FEATURES"
          :key="f.title"
          :title="f.title"
          :description="f.text"
        />
      </div>
    </B24Container>

    <B24Separator />

    <!-- Приватность: у продукта это не сноска, а часть обещания -->
    <B24Container class="py-12 sm:py-16">
      <div class="mx-auto max-w-2xl text-center">
        <p class="text-sm font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">{{ LANDING_SECTIONS.privacy.kicker }}</p>
        <h2 class="mt-2 text-3xl font-bold tracking-tight text-gray-900 dark:text-white">{{ LANDING_SECTIONS.privacy.title }}</h2>
        <p class="mt-3 text-gray-700 dark:text-gray-300">{{ LANDING_SECTIONS.privacy.text }}</p>
      </div>
    </B24Container>

  </main>

  <!-- `footer` вне `main`: внутри него он не считается ориентиром `contentinfo` и пропадает для
       программ чтения с экрана. Ссылки на дашборд здесь НЕТ намеренно: `/d/:key` закрыт гейтом
       портала и анониму с витрины отдаст экран ошибки — та же ловушка, из-за которой спрятана
       кнопка Маркета. Публичное демо аналитики — отдельная задача (#146). -->
  <footer class="border-t border-gray-200 py-8 dark:border-gray-800">
    <B24Container class="flex flex-col items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
      <div class="flex items-center gap-4">
        <B24Link :to="demoSurvey">Посмотреть демо-опрос</B24Link>
        <B24Link to="/docs">Справка</B24Link>
      </div>
      <p>{{ LANDING_TITLE }} · {{ siteHost }}</p>
    </B24Container>
  </footer>
</template>
