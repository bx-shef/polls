import type { FeedbackKind } from '~core/domain/feedback'

/**
 * Отправка отзыва 👍/👎. Держит фазу виджета и текст ошибки.
 *
 * Канал может быть выключен (владелец не настроил приёмник) — тогда `enabled` остаётся `false` и
 * виджет не рисуется. Спрашиваем это у сервера, а не гадаем: настройки живут только на сервере.
 */
export type FeedbackPhase = 'idle' | 'commenting' | 'sending' | 'sent' | 'failed'

export function useFeedback() {
  const phase = ref<FeedbackPhase>('idle')
  const error = ref('')

  // Ответ кэшируется на страницу: настройка канала за время сессии не меняется.
  const { data } = useAsyncData('feedback-enabled', () => $fetch<{ enabled: boolean }>('/api/feedback'), {
    default: () => ({ enabled: false })
  })
  const enabled = computed(() => data.value?.enabled === true)

  async function send(kind: FeedbackKind, comment: string, context: Record<string, unknown>) {
    phase.value = 'sending'
    error.value = ''
    try {
      await $fetch('/api/feedback', { method: 'POST', body: { kind, comment, context } })
      phase.value = 'sent'
    } catch (e) {
      // Сервер кладёт понятный текст в тело (`{ error }`); брошенный выше createError Nitro
      // заворачивает в свой конверт — читаем обе формы, иначе покажем служебное значение.
      const err = e as { statusMessage?: string; data?: { error?: string; data?: { error?: string } } }
      error.value =
        err.data?.error ?? err.data?.data?.error ?? 'Не удалось отправить отзыв. Попробуйте ещё раз позже.'
      phase.value = 'failed'
    }
  }

  return { enabled, phase, error, send }
}
