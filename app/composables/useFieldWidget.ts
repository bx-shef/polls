import { MessageCommands, initializeB24Frame, type B24Frame } from '@bitrix24/b24jssdk'
import { framePass } from '~/utils/frame-auth'
import { isPreview, portalGate } from '~/utils/in-portal'
import { fieldContext } from '~/utils/placement'

/**
 * The frame plumbing both of our field pages share: where the page is, what the portal sent, the server's reply, and the field's height.
 *
 * ⚠ ОДИН КАРКАС НА ДВА ПОЛЯ — «Результат опроса» (`uf/survey-result.vue`) и «Анкету» (`uf/survey-form.vue`).
 * Высоту и ширину фрейма уже дважды правили по ревью (`fit` ниже), и две копии разошлись бы на
 * следующей правке. Вынесено по находке `/code-review` и техдиректора в панели PR #100.
 *
 * ⚠ ТОЛЬКО ЧИТАЕТ. Значение полю своего типа задаёт единственный вызов — `setValue` из его же фрейма, —
 * и здесь его нет. Поэтому поле нередактируемо по построению, в том числе в режиме правки карточки.
 */

/** What a field page says in its own words when the portal or the server lets it down. */
export interface FieldWidgetTexts {
  /** View mode without an element number: the portal sent the context in a shape we do not know. */
  noItem: string
  /** The server refused for a reason the page has no words of its own for. */
  refused: string
  /** The request itself failed. */
  unreachable: string
}

/** A field route's reply: `ok`, or a refusal with its reason. */
export interface FieldReply {
  ok: boolean
  reason?: string
}

/**
 * Ниже этого поле не сжимается, пикселей.
 *
 * Строка «клиент ещё не ответил» короче начальной высоты вчетверо; без нижней границы поле
 * схлопнулось бы до полоски, и соседние поля карточки прыгали бы при каждом открытии.
 */
const MIN_HEIGHT = 60

/** Connects a field page to the portal and to its route; the page keeps its own words and markup. */
export function useFieldWidget<Reply extends FieldReply>(options: {
  /** The field's route: it takes the element number and both signs of the card. */
  endpoint: string
  /** The page's words for each refusal reason — they are fixed differently, and «обновите» helps not all of them. */
  refusals: Record<string, string>
  texts: FieldWidgetTexts
}) {
  const route = useRoute()

  const resolved = ref(false)
  const inPortal = ref(false)
  const loading = ref(true)
  const failure = ref('')
  const editing = ref(false)
  const unsaved = ref(false)
  const reply = shallowRef<Reply | null>(null)

  /** Корень содержимого — по нему меряется высота, см. `fit`. */
  const root = ref<HTMLElement | null>(null)

  const gate = computed(() => portalGate({
    resolved: resolved.value,
    inPortal: inPortal.value,
    preview: isPreview(route.query.preview),
  }))

  /** Связь с порталом. `undefined` — не внутри портала либо ещё не установлена. */
  let frame: B24Frame | undefined
  /** Слежка за размером содержимого. Снимается вместе со страницей. */
  let observer: ResizeObserver | undefined

  onMounted(async () => {
    try {
      frame = await initializeB24Frame()
      inPortal.value = true
    }
    catch {
      // Не внутри портала. Это не ошибка — это единственный способ узнать, где мы.
      inPortal.value = false
    }
    finally {
      resolved.value = true
    }

    if (frame === undefined) {
      loading.value = false
      return
    }

    const context = fieldContext(frame.placement.options)
    editing.value = context.editing

    try {
      if (context.itemId === null) {
        // ⚠ Новая карточка бывает только в режиме правки: там элемента ещё нет, и это не ошибка.
        // В режиме просмотра номер элемента обязан быть — его отсутствие значит, что портал
        // прислал контекст не в той форме, и «ещё не заполнено» было бы неправдой. Нашёл `/review`.
        if (context.editing) unsaved.value = true
        else failure.value = options.texts.noItem
        return
      }

      const pass = await framePass(frame.auth)
      if (pass === null) throw new Error('нет данных авторизации фрейма')

      const answer = await $fetch<Reply>(options.endpoint, {
        method: 'POST',
        body: {
          memberId: pass.memberId,
          authId: pass.authId,
          itemId: context.itemId,
          // Оба признака карточки — серверу: проверять, чья она, должен он, а не страница.
          entityId: context.entityId,
          entityTypeId: context.entityTypeId,
        },
      })
      if (!answer.ok) {
        failure.value = options.refusals[answer.reason ?? ''] ?? options.texts.refused
        return
      }
      reply.value = answer
    }
    catch {
      failure.value = options.texts.unreachable
    }
    finally {
      loading.value = false
      await fit()
      watchSize()
    }
  })

  onBeforeUnmount(() => observer?.disconnect())

  /**
   * Подогнать высоту поля под содержимое.
   *
   * ⚠ Мерим СВОЙ корень, а не документ. Оболочка портальных страниц стоит `min-h-screen`,
   * то есть документ во фрейме никогда не ниже самого фрейма: померив его (`fitWindow`), поле
   * могло бы только расти — после скелета в двести двадцать пикселей строка «ещё не ответил»
   * стояла бы над пустым местом.
   *
   * ⚠ Ширина — `'100%'`, как у `fitWindow`, а не числом. `resizeWindowAuto` шлёт ширину в пикселях,
   * и портал прибил бы фрейм к ширине первого показа: сузили слайдер — поле вылезло за колонку,
   * расширили — пустое место справа. Нашли `/review` и `/code-review`. Поэтому команда та же, что
   * у `fitWindow`, а высота — наша.
   */
  async function fit() {
    if (frame === undefined || root.value === null) return
    await nextTick()
    const height = Math.max(root.value.scrollHeight, root.value.offsetHeight, MIN_HEIGHT)
    try {
      await frame.parent.message.send(MessageCommands.resizeWindow, { width: '100%', height, isSafely: true })
    }
    catch {
      // Портал не подогнал размер — поле останется начальной высоты, с прокруткой внутри.
      // Содержимое при этом видно целиком, так что это косметика, а не отказ.
    }
  }

  /**
   * Подгонять высоту и дальше — когда содержимое меняет размер.
   *
   * Ширина у поля резиновая, и при смене ширины карточки длинные тексты переносятся иначе:
   * подогнав высоту один раз, мы отправили бы их под внутреннюю прокрутку.
   */
  function watchSize() {
    if (root.value === null || typeof ResizeObserver === 'undefined') return
    observer = new ResizeObserver(() => void fit())
    observer.observe(root.value)
  }

  return { gate, loading, failure, editing, unsaved, reply, root }
}
