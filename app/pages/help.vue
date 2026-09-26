<script setup lang="ts">
import { FAQ, FAQ_AGENT_PROMPT, FAQ_INTRO } from '#shared/faq'

/**
 * The app's help: answers for the manager and the portal administrator.
 *
 * ⚠ СТРАНИЦА ПУБЛИЧНАЯ, а layout у неё портальный, и это не противоречие. Открывают её из двух мест:
 * ссылкой снаружи (карточка Маркета, письмо, поиск) и кнопкой «Что это значит?» внутри портала,
 * где она рисуется в слайдере поверх карточки. Своя вёрстка лендинга в слайдере портала выглядела бы
 * чужой страницей, а светлая тема `b24ui` — своей в обоих случаях. Решение соседнего проекта
 * (`client-bank-alfa-by`, `app/pages/help.vue`).
 *
 * ⚠ ГЕЙТА ПРИСУТСТВИЯ В ПОРТАЛЕ ЗДЕСЬ НЕТ, и он был бы вреден. Гейт закрывает страницы, которым
 * нечего показать без фрейма, а справка — текст и работает где угодно. Закрыв её гейтом, мы сделали
 * бы недоступной ровно ту страницу, ссылку на которую даём людям, у которых что-то не работает.
 *
 * ⚠ ТЕКСТ — ТОЛЬКО ИЗ `shared/faq.ts`. Из него же собирается `/llms.txt`, и правка текста здесь,
 * мимо источника, развела бы то, что читает человек, и то, что читает его ИИ-помощник.
 */

definePageMeta({ layout: 'portal' })

useSeoMeta({
  title: 'Справка — Опросы клиентов для Битрикс24',
  description: 'Как отправить опрос клиенту из сделки, где увидеть ответ, как читать баллы, '
    + 'как изменить анкету и где хранятся ответы.',
})

const copied = ref(false)

/** Скопировать инструкцию для ИИ-помощника. Буфер недоступен — в iframe это бывает, текст и так на экране. */
async function copyPrompt(): Promise<void> {
  try {
    await navigator.clipboard.writeText(FAQ_AGENT_PROMPT)
    copied.value = true
  }
  catch {
    copied.value = false
  }
}
</script>

<template>
  <div class="mx-auto flex w-full max-w-[820px] flex-col gap-6 px-4 py-8">
    <div class="flex flex-col gap-2">
      <h1 class="text-2xl font-semibold">
        Справка
      </h1>
      <p class="opacity-80">
        {{ FAQ_INTRO }}
      </p>
    </div>

    <!-- Оглавление: страница длинная, а приходят на неё с одним конкретным вопросом. -->
    <nav
      data-testid="faq-toc"
      class="flex flex-col gap-1"
    >
      <B24Link
        v-for="entry in FAQ"
        :key="entry.id"
        :to="`#${entry.id}`"
        class="text-sm"
      >
        {{ entry.question }}
      </B24Link>
    </nav>

    <section
      v-for="entry in FAQ"
      :id="entry.id"
      :key="entry.id"
      data-testid="faq-entry"
      class="flex scroll-mt-6 flex-col gap-2"
    >
      <h2 class="text-lg font-semibold">
        {{ entry.question }}
      </h2>
      <!-- Только интерполяцией: источник плоский текст, и разметки здесь не бывает по построению. -->
      <p
        v-for="(paragraph, index) in entry.answer"
        :key="index"
        class="leading-relaxed opacity-90"
      >
        {{ paragraph }}
      </p>
    </section>

    <B24Card data-testid="faq-agent">
      <div class="flex flex-col gap-3">
        <h2 class="text-lg font-semibold">
          Для ИИ-помощника
        </h2>
        <p class="text-sm opacity-80">
          Если вы пользуетесь ИИ-помощником, дайте ему эту инструкцию — он будет отвечать по этой справке,
          а не выдумывать названия кнопок. Та же справка простым текстом лежит по адресу /llms.txt.
        </p>
        <pre class="whitespace-pre-wrap text-xs opacity-90">{{ FAQ_AGENT_PROMPT }}</pre>
        <div>
          <B24Button
            :label="copied ? 'Скопировано' : 'Скопировать инструкцию'"
            color="air-secondary-accent"
            size="sm"
            @click="copyPrompt"
          />
        </div>
      </div>
    </B24Card>
  </div>
</template>
