<script setup lang="ts">
// Лендинг (публичная витрина). Тексты — ЕДИНСТВЕННЫМ источником из `app/utils/landing.ts`: те же
// константы кормят обложку для соцсетей (`scripts/lib/ogTemplate.mjs`), поэтому обещание продукта
// не может разойтись между страницей и картинкой. Правка заголовка требует `pnpm og`.
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

useHead({ title: LANDING_TITLE })
useSeoMeta({
  description: LANDING_DESCRIPTION,
  ogTitle: LANDING_TITLE,
  ogDescription: LANDING_DESCRIPTION,
  ogType: 'website',
  ogUrl: LANDING_SITE_URL,
  ogImage: `${LANDING_SITE_URL}/og.png`,
  twitterCard: 'summary_large_image'
})
</script>

<template>
  <main>
    <!-- Герой -->
    <B24Container class="py-16 sm:py-24">
      <div class="flex flex-col items-center gap-6 text-center">
        <B24Badge color="air-secondary-accent" size="md" label="Приложение для Bitrix24" />
        <h1 class="max-w-3xl text-4xl font-bold tracking-tight text-gray-900 sm:text-5xl dark:text-white">
          {{ LANDING_TITLE }}
        </h1>
        <p class="max-w-2xl text-lg text-base-600 dark:text-base-300">
          {{ LANDING_SUBTITLE }}
        </p>

        <ul class="flex flex-wrap justify-center gap-2">
          <li v-for="m in LANDING_METRICS" :key="m">
            <B24Badge color="air-tertiary" size="md" :label="m" />
          </li>
        </ul>

        <div class="flex flex-col items-center gap-3 sm:flex-row">
          <B24Button
            color="air-primary"
            size="lg"
            label="Посмотреть демо-опрос"
            @click="navigateTo(demoSurvey)"
          />
          <!-- Кнопка Маркета появится в день публикации: ссылка на незанятый слаг вела бы на 404. -->
          <B24Button
            v-if="MARKET_PUBLISHED"
            color="air-secondary"
            size="lg"
            label="Установить из Маркета"
            :to="marketUrl()"
            target="_blank"
            rel="noopener"
          />
          <span v-else class="text-sm text-base-500 dark:text-base-400">
            Приложение готовится к публикации в Маркете Битрикс24
          </span>
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
        <p class="text-sm font-medium text-base-500 dark:text-base-400">Как это работает</p>
        <h2 class="mt-2 text-3xl font-bold tracking-tight text-gray-900 dark:text-white">Три шага без участия человека</h2>
        <p class="mt-3 text-base-600 dark:text-base-300">
          От стадии сделки до цифры на дашборде — приложение проходит путь само.
        </p>
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
        <p class="text-sm font-medium text-base-500 dark:text-base-400">Возможности</p>
        <h2 class="mt-2 text-3xl font-bold tracking-tight text-gray-900 dark:text-white">Что получает руководитель</h2>
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
        <p class="text-sm font-medium text-base-500 dark:text-base-400">Приватность</p>
        <h2 class="mt-2 text-3xl font-bold tracking-tight text-gray-900 dark:text-white">Ответы клиентов защищены по умолчанию</h2>
        <p class="mt-3 text-base-600 dark:text-base-300">
          Опрос анонимный: пока ответов меньше пяти, цифры не показываются вовсе — по маленькой
          выборке можно было бы узнать конкретного человека. Данные лежат в базе на вашем сервере,
          а не у нас.
        </p>
      </div>
    </B24Container>

    <footer class="border-t border-base-200 py-8 dark:border-base-800">
      <B24Container class="flex flex-col items-center gap-2 text-sm text-base-500 dark:text-base-400">
        <div class="flex flex-wrap justify-center gap-4">
          <B24Link :to="demoSurvey">Демо-опрос</B24Link>
          <B24Link :to="`/d/${LANDING_DEMO_SURVEY}`">Демо-дашборд</B24Link>
        </div>
        <p>{{ LANDING_TITLE }} · {{ LANDING_SITE_URL.replace('https://', '') }}</p>
      </B24Container>
    </footer>
  </main>
</template>
