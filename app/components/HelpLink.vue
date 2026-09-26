<script setup lang="ts">
import { initializeB24Frame } from '@bitrix24/b24jssdk'
import { HELP_SLIDER_WIDTH, SLIDER_ANSWER_MS, SLIDER_PENDING, helpPlace, isSliderRefusal } from '~/utils/help'

// A contextual link into the help: «Что это значит?» right where people get stuck.
//
// ⚠ Открывается НАСТОЯЩИМ слайдером портала, а не переходом внутри фрейма: вкладку сделки или
// конструктор уводить нельзя — там может быть несохранённая работа. Слайдер ложится поверх и
// закрывается крестиком портала, а вкладка остаётся как была. Приём — у соседнего проекта
// (`client-bank-alfa-by`, `app/components/HelpLink.vue`).
//
// ⚠ Запасной путь — новая вкладка браузера, и он обязателен. Вне портала слайдера нет, а внутри
// портал может отказать — в мобильном клиенте, во вложенном слайдере. Без запасного пути кнопка
// молча не делала бы ничего — ровно тот отказ, который снаружи неотличим от поломки.
//
// ⚠ Отказ портала распознаётся по БЫСТРОМУ ответу, а не по завершению промиса: он завершается,
// только когда слайдер закроют. Разбор — у `SLIDER_ANSWER_MS`.
const props = withDefaults(defineProps<{
  /** Якорь раздела справки — `id` из `shared/faq.ts`. Что он существует, проверяет тест. */
  anchor: string
  label?: string
}>(), { label: 'Что это значит?' })

/**
 * Идёт ли открытие.
 *
 * ⚠ Без него двойной щелчок, пока слайдер ещё выезжает, отправлял бы две просьбы, и поверх вкладки
 * легли бы два одинаковых слайдера: закрыв один, человек видел бы второй. Нашёл `/code-review`.
 * Держат двое: кнопка на это время гаснет (`loading`), а `open` вдобавок сама не пускает второй
 * вызов — на случай, если набор однажды перестанет гасить кнопку в загрузке.
 */
const opening = ref(false)

async function open(): Promise<void> {
  if (opening.value) return
  opening.value = true
  try {
    if (await openInSlider()) return
    window.open(`/help#${props.anchor}`, '_blank', 'noopener')
  }
  finally {
    opening.value = false
  }
}

/** `true` — портал открыл слайдер; `false` — портала нет или он отказал. */
async function openInSlider(): Promise<boolean> {
  let frame
  try {
    frame = await initializeB24Frame()
  }
  catch {
    return false
  }

  const answer = await Promise.race([
    frame.slider.openSliderAppPage({
      place: helpPlace(props.anchor),
      bx24_width: HELP_SLIDER_WIDTH,
      bx24_title: 'Справка',
    }).catch((error: unknown) => error instanceof Error ? error : new Error('slider refused')),
    new Promise(resolve => setTimeout(() => resolve(SLIDER_PENDING), SLIDER_ANSWER_MS)),
  ])
  return !isSliderRefusal(answer)
}
</script>

<template>
  <B24Button
    color="link"
    size="sm"
    :loading="opening"
    data-testid="help-link"
    @click="open"
  >
    {{ label }}
  </B24Button>
</template>
