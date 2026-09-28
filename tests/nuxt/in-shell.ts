import { mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h, type Component } from 'vue'
import AppShell from '../../app/components/AppShell.vue'

/**
 * Mounts a portal screen inside `AppShell` — the way the `portal` layout wraps it in the app.
 *
 * ⚠ Заведено вместе со значком справки (issue #84, п. 17). `mountSuspended` layout'ов не применяет,
 * а подсказка набора (`B24Tooltip`) без `<B24App>` над собой не монтируется вовсе: ей нужен
 * `TooltipProvider`, и без него она падает на первом же рендере. В приложении `<B24App>` ставит
 * `AppShell` — значит, и в тестах экран живёт в нём, а не в подставной обёртке: так тест видит
 * ту же оболочку, что и человек в портале.
 */
export function mountInShell(component: Component, options: { route?: string, props?: Record<string, unknown> } = {}) {
  const InShell = defineComponent({
    name: 'InShell',
    setup: () => () => h(AppShell, null, { default: () => h(component, options.props ?? {}) }),
  })
  return mountSuspended(InShell, options.route === undefined ? {} : { route: options.route })
}
