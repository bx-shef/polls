<script setup lang="ts">
import HelpIcon from '@bitrix24/b24icons-vue/main/HelpIcon'
import { initializeB24Frame } from '@bitrix24/b24jssdk'
import { HELP_SLIDER_WIDTH, SLIDER_ANSWER_MS, SLIDER_PENDING, helpPlace, isSliderRefusal } from '~/utils/help'

// A contextual way into the help: a question icon right next to the heading people get stuck on.
//
// ⚠ ЗНАЧОК, а не текстовая ссылка, — решение владельца по живой проверке 28.09 (issue #84, п. 17).
// Восемь текстовых «Что это значит?» и «Как это работает?» спорили с самим текстом экрана, а кнопка
// `color="link"` вдобавок несла свой отступ и не вставала ровно под текст над ней. Образец — пример
// «Help Icon» у `B24Tooltip` в документации набора: значок у заголовка, пояснение — подсказкой.
//
// ⚠ Но КНОПКА, а не голый значок из того примера. Значок не получает фокуса и не нажимается
// с клавиатуры, экранный диктор его не называет, а на телефоне у него нет наведения — подсказка
// там не всплывёт вовсе. Кнопка с `aria-label` даёт всё сразу: фокус, Enter, имя для диктора;
// касание просто открывает справку, как и щелчок мышью.
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
  /** Что объясняет раздел: текст подсказки и имя кнопки для экранного диктора. */
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
  <!--
    ⚠ Цвет значка — ЦВЕТ ТЕКСТА ВОКРУГ (`--ui-btn-color: currentColor`), а не свой. Значок стоит
    и у обычного заголовка на белом, и в заголовке залитой оранжевой плашки «ещё настраивается»:
    серый значок набора на оранжевом не читался бы. У голой иконки из примера документации цвет
    ровно такой же — `currentColor` у самого SVG. Переменная, а не класс цвета: ею же набор красит
    кнопку при наведении и нажатии, и значок не перекрашивается обратно в серый под курсором.
    Размер значка — `size-5`, как в том же примере: у кнопки `xs` свой значок мельче, и на скриншоте
    он читался точкой, а не вопросом.
  -->
  <B24Tooltip
    :text="label"
    :delay-duration="100"
    :content="{ side: 'right' }"
  >
    <B24Button
      :icon="HelpIcon"
      :aria-label="label"
      :b24ui="{ leadingIcon: 'size-5' }"
      color="air-tertiary-no-accent"
      size="xs"
      rounded
      :loading="opening"
      style="--ui-btn-color: currentColor"
      data-testid="help-link"
      @click="open"
    />
  </B24Tooltip>
</template>
