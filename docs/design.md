# Дизайн на Bitrix24 UI (b24ui)

> Как экраны и блоки прототипа ложатся на компоненты **Bitrix24 UI**
> (`@bitrix24/b24ui-nuxt`). Документация компонентов:
> <https://bitrix24.github.io/b24ui/llms.txt>. Структуру и поведение см. в
> [`brief.md`](./brief.md) (§3 — стадии, §5 — «Другое», §7 — токены прототипа).
>
> Компоненты b24ui используют префикс **`B24`** и семантические цвета `air-*`
> (не хардкод-hex). Темизация — Tailwind CSS + CSS-переменные, переключение
> светлая/тёмная через VueUse. Код ниже — **иллюстративный** (дизайн-спека, не
> финальная реализация); точные имена иконок берутся из `@bitrix24/b24icons-vue`.

---

## Оглавление

1. [Подход и принципы](#1-подход-и-принципы)
2. [Дизайн-система: токены прототипа → тема b24ui](#2-дизайн-система-токены-прототипа--тема-b24ui)
3. [Карта компонентов (блок прототипа → b24ui)](#3-карта-компонентов-блок-прототипа--b24ui)
4. [Экран 1 — Интро](#4-экран-1--интро)
5. [Экран 2 — Опрос](#5-экран-2--опрос)
6. [Экран 3 — Спасибо](#6-экран-3--спасибо)
7. [Контур B — дашборд результатов](#7-контур-b--дашборд-результатов)
8. [Адаптив: десктоп и мобильный](#8-адаптив-десктоп-и-мобильный)
9. [Иконки, темы, доступность](#9-иконки-темы-доступность)
10. [Готовое из b24ui vs кастом](#10-готовое-из-b24ui-vs-кастом)

---

## 1. Подход и принципы

- **Компоненты — из b24ui, поведение — из прототипа.** Берём готовые
  `B24RadioGroup`, `B24CheckboxGroup`, `B24Input`, `B24Button`, `B24Progress`,
  `B24Alert`, дашборд-компоненты; механику (навигация, «Другое», exclusive,
  валидация, persist, клавиатура) переносим из `brief.md`.
- **Два визуальных режима** (см. §2):
  - **Публичный опрос (контур A)** — сохраняем айдентику прототипа (крупная
    типографика, индиго-акцент, тёплый фон): это лендинг-подобный публичный
    опыт.
  - **Дашборд результатов (контур B)** — нативная тема b24ui `air-*`
    (консистентность с интерфейсом Bitrix24).
- **Одна карточка-вариант = один компонент группы.** Не верстаем кнопки руками:
  `variant="card"` у RadioGroup/CheckboxGroup даёт ровно вид `.opt` из прототипа
  (рамка, индикатор-«марка», выделение выбранного).
- **Mobile-first адаптив** — той же логикой, что в прототипе (рейл → скрыт,
  нав → прилипает к низу, 2 колонки → 1).

---

## 2. Дизайн-система: токены прототипа → тема b24ui

b24ui темизируется через CSS-переменные (Tailwind). Палитру прототипа (§7 брифа)
переносим в **бренд-токены** и привязываем к компонентам.

| Роль | Прототип (§7) | В b24ui |
|---|---|---|
| Акцент | `#5B5BD6` индиго | `color="air-primary"` + переопределение primary-токена на индиго (контур A) / штатный `air-primary` (контур B) |
| Фон выбранного | `#EEEEFB` | штатная заливка `variant="card"` выбранного состояния |
| Успех | `#1F9D6B` | `air-primary-success` |
| Ошибка/алерт | `#D6453B` | `air-primary-alert` |
| Фон страницы | `#FBFBF9` | переменная фона темы (контур A — тёплый off-white) |
| Текст/границы | `#15161A` / `#E7E7E2` | штатные нейтрали темы |

**Типографика.** Unbounded (заголовки/номера), Inter (UI), JetBrains Mono (мета,
счётчики) подключаем как в прототипе и привязываем к токенам шрифтов темы. На
дашборде (контур B) — оставляем системные шрифты b24ui.

> Конкретные имена CSS-переменных темы берём из раздела темизации b24ui; здесь
> важен принцип: **акцент = `air-primary`**, состояние выбора/успеха/ошибки — через
> семантические `air-*`, а не через произвольные классы.

```css
/* контур A: бренд-токены поверх темы b24ui (псевдокод темизации) */
:root {
  --b24-brand-accent: #5B5BD6;   /* индиго прототипа */
  --b24-brand-page:   #FBFBF9;
  --ui-font-display:  "Unbounded", system-ui, sans-serif;
  --ui-font-ui:       "Inter", system-ui, sans-serif;
  --ui-font-mono:     "JetBrains Mono", ui-monospace, monospace;
}
```

---

## 3. Карта компонентов (блок прототипа → b24ui)

| Блок прототипа (§ брифа) | Компонент(ы) b24ui | Ключевые props |
|---|---|---|
| Топ-полоса прогресса (§3.2) | `B24Progress` | `:model-value="current+1"`, `:max="25"`, `size="xs"` |
| Прогресс в рейле (§3.2) | `B24Progress` | `size="sm"`, `status` |
| Чипы интро «Анонимно…» (§3.1) | `B24Badge` | `color="air-secondary"`, `size="md"` |
| CTA «Начать опрос» (§3.1) | `B24Button` | `color="air-primary"`, `size="xl"`, `block` (моб.) |
| Заголовок вопроса (§3.2) | `B24FormField` | `:label`, `:error`, слот `#label` |
| Вопрос `single` (§4) | `B24RadioGroup` | `variant="card"`, `:items`, `v-model`, `color="air-primary"` |
| Вопрос `multi` (§4) | `B24CheckboxGroup` | `variant="card"`, `:items`, `v-model` (массив) |
| Вопрос `text` (§4) | `B24Textarea` | `:rows`, `:maxlength="2000"`, `v-model`, счётчик в `#trailing` |
| Хинт клавиши `1`–`9` (§3.2) | `B24Kbd` в слоте `#label` | — |
| «Другое» поле (§5) | `B24Input` | `:maxlength="80"`, слот `#trailing` (счётчик), `underline` |
| Навигация Назад/Далее (§3.4) | `B24Button` | primary / `air-secondary-no-accent`, `loading`, `trailing` |
| Ошибка валидации (§3.4) | `B24FormField error` / `B24Alert` | `color="air-primary-alert"` |
| Тост ошибки отправки (§6) | `B24Toast` | `color="air-primary-alert"` |
| Экран «Спасибо» (§6) | `B24Alert` / `B24Card` | `color="air-primary-success"`, `icon` |
| Дашборд: каркас (§9-B) | `B24DashboardGroup` + `B24DashboardSidebar` + `B24DashboardNavbar` | `collapsible`, `storage="local"` |
| Дашборд: страницы (§9-B) | `B24Page` + `B24PageHeader` + `B24PageBody` | слоты `left/right` |
| Дашборд: таблицы (§9-B) | `B24Table` | `:data`, `:columns` (TanStack), `sticky` |
| Дашборд: графики (§9-B) | `@unovis/vue` | bar/line/donut |

---

## 4. Экран 1 — Интро

**Композиция:** шапка (вордмарк + «Опрос ’00», поле `intro.year`) → крупный заголовок (Unbounded) →
лид → ряд `B24Badge` → `B24Button` CTA + подпись «25 вопросов · 8 блоков».
Honeypot — скрытый `<input>` (§8 брифа).

```vue
<template>
  <section class="intro">
    <header class="intro__top">
      <span class="wordmark">{{ schema.intro.wordmark }}<i class="dot">.</i></span>
      <span class="intro__year">{{ schema.intro.year }}</span>
    </header>

    <div class="intro__body">
      <p class="intro__kicker">{{ schema.intro.kicker }}</p>
      <h1 class="intro__title">{{ schema.intro.title }}</h1>
      <p class="intro__lead">{{ schema.intro.lead }}</p>

      <div class="intro__meta">
        <B24Badge v-for="m in schema.intro.meta" :key="m" color="air-secondary" size="md">
          {{ m }}
        </B24Badge>
      </div>
    </div>

    <footer class="intro__foot">
      <B24Button color="air-primary" size="xl" :block="isMobile" :trailing-icon="ArrowRightIcon"
                 @click="startSurvey">
        {{ schema.intro.cta }}
      </B24Button>
      <span class="intro__count">{{ schema.intro.count }}</span>
    </footer>

    <!-- honeypot (анти-бот) -->
    <input v-model="hp" type="text" tabindex="-1" autocomplete="off" aria-hidden="true" class="hp" />
  </section>
</template>
```

Заголовок/вордмарк/чипы — это айдентика, поэтому типографику оставляем кастомной
(токены §2), а интерактив (кнопка, бейджи) — на b24ui.

---

## 5. Экран 2 — Опрос

### 5.1. Раскладка

Двухколоночная сетка `rail | stage` на десктопе; на мобайле рейл скрыт, добавлен
sticky-хедер и нижняя нав-панель (см. §8).

```
┌───────────────┬───────────────────────────────┐
│  SurveyRail   │  stage                         │
│  (десктоп)    │   ├ FormField(заголовок+хелпер) │
│  блок/номер   │   ├ B24RadioGroup / Checkbox    │  ← variant="card"
│  B24Progress  │   ├ OtherField (B24Input)       │
│  хинты клавиш  │   └ nav: B24Button × 2          │
└───────────────┴───────────────────────────────┘
```

### 5.2. Левый рейл (десктоп)

Имя блока (моно), крупный номер `01 / 25` (Unbounded), `B24Progress`, счётчик
«Вопрос N из 25», внизу — хинты клавиш через `B24Kbd`.

```vue
<aside class="rail">
  <div class="rail__block">{{ blocks[q.block] }}</div>
  <div class="rail__num">{{ pad(current + 1) }} <small>/ {{ total }}</small></div>
  <B24Progress :model-value="current + 1" :max="total" size="sm" color="air-primary" />
  <div class="rail__count">Вопрос {{ current + 1 }} из {{ total }}</div>
  <div class="rail__kbd">
    <B24Kbd>1</B24Kbd>–<B24Kbd>9</B24Kbd> выбор
    <B24Kbd>↵</B24Kbd> далее <B24Kbd>←</B24Kbd><B24Kbd>→</B24Kbd> навигация
  </div>
</aside>
```

### 5.3. Вопрос `single` → `B24RadioGroup variant="card"`

`variant="card"` даёт ровно вид `.opt`: карточка с индикатором-«радио»,
выделение выбранного. Хинт клавиши `1`–`9` — через слот `#label`.

```vue
<script setup lang="ts">
const items = computed(() => q.options.map((o, i) => ({
  label: o.label, value: o.key, key: i < 9 ? i + 1 : null, other: !!o.isOther
})))
const value = ref<string | null>(null)   // ↔ answers[current]
</script>

<template>
  <B24RadioGroup
    v-model="value"
    :items="items"
    variant="card"
    color="air-primary"
    value-key="value"
    :b24ui="{ fieldset: 'gap-2.5' }"
  >
    <template #label="{ item }">
      <span class="opt__label">{{ item.label }}</span>
      <B24Kbd v-if="item.key" class="opt__key">{{ item.key }}</B24Kbd>
    </template>
  </B24RadioGroup>

  <!-- поле «Другое» появляется при выборе варианта other -->
  <OtherField v-if="isOtherSelected(value)" v-model="other" />
</template>
```

### 5.4. Вопрос `multi` → `B24CheckboxGroup variant="card"` (+ exclusive, columns)

То же, но `v-model` — массив, индикатор-«чекбокс». Правило `exclusive`
(§4 брифа) реализуем в обработчике: выбор исключающего варианта очищает прочие и
наоборот. Двухколоночность (`columns: 2`) — грид-класс на группе, на мобайле в 1
колонку.

```vue
<template>
  <B24CheckboxGroup
    v-model="values"
    :items="items"
    variant="card"
    color="air-primary"
    value-key="value"
    :b24ui="{ fieldset: q.columns === 2 ? 'grid grid-cols-1 md:grid-cols-2 gap-2.5' : 'gap-2.5' }"
    @update:model-value="applyExclusiveRule"
  >
    <template #label="{ item }">
      <span class="opt__label">{{ item.label }}</span>
      <B24Kbd v-if="item.key" class="opt__key">{{ item.key }}</B24Kbd>
    </template>
  </B24CheckboxGroup>

  <OtherField v-if="values.includes('other')" v-model="other" />
</template>
```

```ts
// exclusive: выбор «ничего/нет/не изменилось» снимает остальные, и наоборот
function applyExclusiveRule(next: string[]) {
  const exclusiveId = q.options.find(o => o.isExclusive)?.key
  if (!exclusiveId) return
  const justAddedExclusive = next.at(-1) === exclusiveId
  values.value = justAddedExclusive ? [exclusiveId] : next.filter(v => v !== exclusiveId)
}
```

### 5.5. Вопрос `text` → `B24Textarea`

Отдельный вопрос со свободным ответом (`type: 'text'`, `metric: 'text'` — напр.
финальный комментарий). На сервере нормализуется в `valueText` (trim; пустой →
ответ не сохраняется, см. `normalizeAnswer`). Обязательный `text`-вопрос без
непустого значения даёт ошибку «Заполните поле».

```vue
<script setup lang="ts">
const model = defineModel<string>({ default: '' })
</script>

<template>
  <B24FormField :label="question.text" :error="error">
    <B24Textarea
      v-model="model"
      :rows="4"
      :maxlength="2000"
      placeholder="Ваш ответ…"
      color="air-primary"
    >
      <template #trailing>
        <span class="ta__count">{{ model.length }}/2000</span>
      </template>
    </B24Textarea>
  </B24FormField>
</template>
```

### 5.6. «Другое — свой вариант» → `B24Input` со счётчиком

Раскрывающееся поле (`B24Collapsible` или CSS grid-rows как в прототипе),
`maxlength=80`, счётчик «X/80» в слоте `#trailing`, автофокус при выборе (§5
брифа).

```vue
<script setup lang="ts">
const model = defineModel<string>({ default: '' })
const input = useTemplateRef('input')
onMounted(() => setTimeout(() => input.value?.focus(), 180))  // автофокус 180мс
</script>

<template>
  <div class="other-wrap">
    <B24Input
      ref="input"
      v-model="model"
      :maxlength="80"
      placeholder="Свой вариант…"
      color="air-primary"
      underline
    >
      <template #trailing>
        <span class="other-field__count">{{ model.length }}/80</span>
      </template>
    </B24Input>
  </div>
</template>
```

### 5.7. Прогресс

- **Топ-полоса** (фиксированная, появляется в опросе): `B24Progress size="xs"`.
- **Рейл**: `B24Progress size="sm"` (см. 5.2).

```vue
<B24Progress :model-value="current + 1" :max="total" size="xs" color="air-primary"
             class="fixed inset-x-0 top-0 z-50" />
```

### 5.8. Навигация и валидация

«Назад» — вторичная кнопка (выключена на Q1), «Далее/Отправить» — primary с
загрузкой при отправке. Заголовок+хелпер оборачиваем в `B24FormField`, чтобы
показывать ошибку «Выберите вариант» в его слоте `error` (§3.4 брифа).

```vue
<B24FormField
  :label="q.text"
  :hint="q.required === false ? 'необязательно' : undefined"
  :description="q.type === 'multi' ? 'Можно выбрать несколько' : 'Один вариант'"
  :error="showError ? (q.type === 'multi' ? 'Выберите хотя бы один вариант' : 'Выберите вариант') : undefined"
>
  <!-- RadioGroup / CheckboxGroup из 5.3–5.4 -->
</B24FormField>

<div class="nav">
  <B24Button color="air-secondary-no-accent" :disabled="current === 0"
             :leading-icon="ArrowLeftIcon" @click="goBack">Назад</B24Button>
  <span class="nav__hint"><B24Kbd>Enter</B24Kbd> далее</span>
  <B24Button color="air-primary" :loading="sending" :trailing-icon="ArrowRightIcon"
             :block="isMobile" @click="goNext">
    {{ isLast ? (sending ? 'Отправляем' : 'Отправить') : 'Далее' }}
  </B24Button>
</div>
```

Пошаговая валидация — вручную через `useSurvey` (`isAnswered()`), необязательные
вопросы пропускаются. Для финальной отправки можно дополнительно прогнать всю
`zod`-схему через `B24Form` (см. §11 брифа).

---

## 6. Экран 3 — Спасибо

`B24Alert` (или центрированная `B24Card`) с иконкой-галочкой и успехом. Вариант
«вы уже проходили» — те же компоненты, другой текст (§6 брифа).

```vue
<template>
  <section class="thanks">
    <B24Alert
      :icon="CheckIcon"
      color="air-primary-success"
      :title="done ? 'Вы уже проходили опрос' : schema.thanks.title"
      :description="done ? 'Спасибо — ваш ответ уже записан.' : schema.thanks.body"
      class="thanks__card"
    />
    <p v-if="!done" class="thanks__note">{{ schema.thanks.note }}</p>
  </section>
</template>
```

Ошибка отправки — `B24Toast` (`color="air-primary-alert"`, автоскрытие), кнопка
«Отправить» возвращается из `loading` (§6 брифа).

---

## 7. Контур B — дашборд результатов

Закрытый дашборд внутри Bitrix24 — на «родных» dashboard-компонентах b24ui.

```vue
<!-- app/layouts/dashboard.vue -->
<template>
  <B24DashboardGroup storage="local" storage-key="polls-dashboard">
    <B24DashboardSidebar collapsible>
      <template #header="{ collapsed }">
        <Logo v-if="!collapsed" />
      </template>
      <B24NavigationMenu :items="nav" orientation="vertical" />
    </B24DashboardSidebar>

    <div class="flex-1">
      <B24DashboardNavbar title="Результаты опроса">
        <template #leading><B24DashboardSidebarCollapse /></template>
        <template #trailing>
          <B24ColorModeSwitch />
          <B24Badge :label="`${totalResponses} ответов`" color="air-primary" />
        </template>
      </B24DashboardNavbar>

      <slot />
    </div>
  </B24DashboardGroup>
</template>
```

```vue
<!-- app/pages/dashboard/results/[block].vue -->
<template>
  <B24Page>
    <B24PageHeader :title="blockTitle" :description="`Вопросов: ${questions.length}`" />
    <B24PageBody>
      <!-- распределение ответов на вопрос: график + таблица -->
      <B24Card v-for="q in questions" :key="q.key" :title="q.text" class="mb-4">
        <VisXYContainer :data="q.distribution">
          <VisStackedBar :x="(d,i)=>i" :y="(d)=>d.count" />
          <VisAxis type="x" :tickFormat="(i)=>q.distribution[i].label" />
        </VisXYContainer>

        <B24Table :data="q.distribution" :columns="distColumns" />
      </B24Card>
    </B24PageBody>
  </B24Page>
</template>

<script setup lang="ts">
const distColumns = [
  { accessorKey: 'label', header: 'Вариант' },
  { accessorKey: 'count', header: 'Ответов' },
  { accessorKey: 'pct',   header: 'Доля', cell: ({ row }) => `${row.original.pct}%` }
]
</script>
```

Данные — агрегаты из PostgreSQL через `server/api/stats/*` (только для
авторизованных). Командная палитра (`B24CommandPalette`/`B24DashboardSearch`) и
тёмная тема идут из шаблона «из коробки».

---

## 8. Адаптив: десктоп и мобильный

Поведение совпадает с прототипом (§7.2 брифа), реализуется Tailwind-брейкпоинтами.

| Ширина | Раскладка |
|---|---|
| **≥ 1280px** | 2 колонки `rail \| stage`; рейл 38%; видны хинты клавиш; `columns:2` → 2 колонки опций |
| **1024–1280px** | то же, рейл ~34% |
| **≤ 1023px** | 1 колонка; `aside.rail` → `hidden`; sticky-хедер (блок + `NN/25`) с `backdrop-blur`; нав-панель `fixed bottom-0` с `safe-area`; `B24Button block`; хинт «Enter» скрыт; `columns:2` → 1 колонка |

```vue
<!-- мобильный хедер вместо рейла -->
<div class="mhead md:hidden sticky top-0 backdrop-blur ...">
  <span class="mhead__block">{{ blocks[q.block] }}</span>
  <span class="mhead__num">{{ pad(current + 1) }} / {{ total }}</span>
</div>

<!-- нав: в потоке на десктопе, прилипает к низу на мобайле -->
<div class="nav md:static fixed inset-x-0 bottom-0 md:bg-transparent backdrop-blur md:backdrop-blur-none ...">
  …кнопки…
</div>
```

Группы `variant="card"` остаются вертикальными; двухколоночность включается
классом `md:grid-cols-2` на `fieldset` (см. 5.4).

---

## 9. Иконки, темы, доступность

- **Иконки** — `@bitrix24/b24icons-vue` (галочка, стрелки, инфо). Импортируются
  как Vue-компоненты и передаются в `:icon` / `:trailing-icon` / `:leading-icon`.
  Точные имена — из каталога b24icons.
- **Темы** — публичный опрос фиксируем светлым (как прототип); на дашборде —
  `B24ColorModeSwitch` (светлая/тёмная).
- **Доступность** — у RadioGroup/CheckboxGroup штатные `role`/`aria-checked` и
  фокус-ринг b24ui; `prefers-reduced-motion` уважаем (анимации появления/`pop`
  глушим). Клавиатура `1`–`9` / стрелки / Enter — поверх, через `useSurvey`.

---

## 10. Готовое из b24ui vs кастом

| Берём готовым (b24ui) | Делаем кастомом (айдентика прототипа) |
|---|---|
| RadioGroup/CheckboxGroup (`card`), Input, Button, Progress, Badge, Kbd, Alert, Toast, FormField | Крупная типографика интро (Unbounded), вордмарк с акцентной точкой |
| Весь дашборд (DashboardGroup/Sidebar/Navbar, Page, Table, графики) | Левый рейл опроса (sticky, градиент, крупный номер) — каркас свой, прогресс из b24ui |
| Темизация, светлая/тёмная, командная палитра, i18n-хром | Тонкая фоновая зернистость, анимации `qin`/`pop`, поле «Другое» (раскрытие) |

Принцип: **интерактивные элементы и данные — на b24ui** (консистентность,
доступность, темы), **бренд-обёртка публичного опроса — кастомная** (узнаваемый
вид, как в прототипе).

---

*Спецификация структуры и поведения — [`brief.md`](./brief.md). Обезличенный
шаблон схемы — [`reference/survey-schema.template.json`](./reference/survey-schema.template.json).*

*Последнее ревью: 2026-06-13.*
