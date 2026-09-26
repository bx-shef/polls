<script setup lang="ts">
import { initializeB24Frame } from '@bitrix24/b24jssdk'
import { HELP_SLIDER_WIDTH, helpPlace } from '~/utils/help'

// A contextual link into the help: «Что это значит?» right where people get stuck.
//
// ⚠ Открывается НАСТОЯЩИМ слайдером портала, а не переходом внутри фрейма: вкладку сделки или
// конструктор уводить нельзя — там может быть несохранённая работа. Слайдер ложится поверх и
// закрывается крестиком портала, а вкладка остаётся как была. Приём — у соседнего проекта
// (`client-bank-alfa-by`, `app/components/HelpLink.vue`).
//
// ⚠ Запасной путь — новая вкладка браузера, и он обязателен. Вне портала слайдера нет, а внутри
// портал может отказать во ВЛОЖЕННОМ слайдере. Без запасного пути кнопка молча не делала бы ничего —
// ровно тот отказ, который снаружи неотличим от поломки. Переход внутри фрейма запасным путём
// не годится по той же причине, что и основным.
const props = withDefaults(defineProps<{
  /** Якорь раздела справки — `id` из `shared/faq.ts`. Что он существует, проверяет тест. */
  anchor: string
  label?: string
}>(), { label: 'Что это значит?' })

async function open(): Promise<void> {
  try {
    const frame = await initializeB24Frame()
    await frame.slider.openSliderAppPage({
      place: helpPlace(props.anchor),
      bx24_width: HELP_SLIDER_WIDTH,
      bx24_title: 'Справка',
    })
    return
  }
  catch {
    // Не внутри портала либо портал отказал — ниже запасной путь.
  }
  window.open(`/help#${props.anchor}`, '_blank', 'noopener')
}
</script>

<template>
  <B24Button
    color="link"
    size="sm"
    :data-anchor="anchor"
    data-testid="help-link"
    @click="open"
  >
    {{ label }}
  </B24Button>
</template>
