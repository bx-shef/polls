<script setup lang="ts">
import { initializeB24Frame, type B24Frame } from '@bitrix24/b24jssdk'
import { readFramePass } from '~/utils/frame-auth'

/**
 * The setup wizard the portal shows when the app is installed.
 *
 * ⚠ Эта страница ОБЯЗАТЕЛЬНА для тиражного приложения с пунктом в левом меню, и без неё
 * приложение не работает вовсе. Битрикс24 считает его неустановленным, пока отсюда
 * не вызовут `installFinish()`: встройки не появляются, даже если `placement.bind`
 * отработал успешно, и события не приходят, даже после успешного `event.bind`. Снаружи это
 * выглядит как «поставили, а вкладки нет» — и причина не находится ничем, кроме этой строки
 * в документации.
 *
 * Порядок здесь и есть смысл файла, и он не переставляется:
 *
 * 1. Взять грант из фрейма. Только фрейм знает `refresh_token` администратора — по нему
 *    сервер докажет, что установка настоящая.
 * 2. Отдать его нашему серверу. Он переавторизуется, сохранит токены и создаст
 *    смарт-процессы. Половина этого браузеру недоступна в принципе.
 * 3. И только потом `installFinish()`. Вызвать его раньше значит объявить установку
 *    состоявшейся, не зная, состоялась ли она: второй раз мастер не откроется, а чинить
 *    придётся переустановкой.
 */

definePageMeta({ layout: 'portal' })

type Stage = 'starting' | 'installing' | 'done' | 'partial' | 'failed'

/**
 * Почему обустройство не прошло — словами, которые говорят, ЧТО делать.
 *
 * Ключ — причина от `/api/portal/provision`. Незнакомая причина попадает в общий текст:
 * соврать про способ починки хуже, чем признать, что причина неизвестна.
 */
const REASONS: Record<string, string> = {
  'not-admin': 'Прав администратора по-прежнему нет.',
  'no-scope': 'Приложению не выданы нужные разрешения. Это правится в карточке приложения '
    + 'в партнёрском кабинете — нужны «crm», «userfieldconfig» и «placement», — а потом '
    + 'приложение надо переустановить. Повтор здесь не поможет.',
}

const stage = ref<Stage>('starting')
const failure = ref('')

let frame: B24Frame | undefined

useHead({ title: 'Установка приложения' })

/** Отказы сервера, у каждого свой текст: «попробуйте ещё раз» на нехватку прав — обман. */
const REFUSALS: Record<number, string> = {
  400: 'Портал прислал данные, которых мы не ожидали. Попробуйте переустановить приложение.',
  403: 'Портал не подтвердил установку. Обычно это значит, что приложение устанавливает не администратор.',
  429: 'Слишком много попыток подряд. Подождите минуту и откройте приложение снова.',
  503: 'Приложение сейчас не может завершить установку. Попробуйте через несколько минут.',
}

const busy = ref(false)
/**
 * Есть ли связь с порталом.
 *
 * Отдельный признак, а не `frame !== undefined` в шаблоне: `frame` — обычная переменная,
 * Vue за ней не следит, и условие в разметке зависело бы от того, что перерисовку вызвало
 * изменение `stage` раньше. Работало бы, но держалось на порядке присваиваний.
 */
const connected = ref(false)

onMounted(async () => {
  try {
    frame = await initializeB24Frame()
    connected.value = true
  }
  catch {
    stage.value = 'failed'
    failure.value = 'Не удалось связаться с порталом. Обновите страницу.'
    return
  }

  await install()
})

async function install() {
  stage.value = 'installing'
  failure.value = ''

  const pass = readFramePass(frame!.auth.getAuthData())
  if (pass === null || pass.refreshToken === '') {
    stage.value = 'failed'
    failure.value = 'Портал не передал данные авторизации. Переустановите приложение.'
    return
  }

  let result: { ok: boolean, provisioned?: boolean }
  try {
    result = await $fetch<{ ok: boolean, provisioned?: boolean }>('/api/portal/install', {
      method: 'POST',
      // ⚠ Отдаём ровно то, что нужно серверу для доказательства, и ничего сверх.
      // Имена полей — как у события установки: разбирает их один и тот же код.
      body: {
        auth: {
          domain: pass.domain,
          member_id: pass.memberId,
          refresh_token: pass.refreshToken,
        },
      },
    })
  }
  catch (error) {
    stage.value = 'failed'
    const status = (error as { statusCode?: number }).statusCode ?? 0
    failure.value = REFUSALS[status] ?? 'Установка не завершилась. Попробуйте ещё раз.'
    return
  }

  if (!result.ok) {
    stage.value = 'failed'
    failure.value = 'Установка не завершилась. Попробуйте ещё раз.'
    return
  }

  // ⚠ `installFinish` зовётся и при неполном обустройстве. Токены сохранены, приложение
  // живо — держать его «неустановленным» из-за смарт-процессов значит запереть
  // администратора в мастере навсегда, без единого способа что-то поправить.
  // Неполноту показываем словами, а не молчанием.
  stage.value = result.provisioned === true ? 'done' : 'partial'
  try {
    await frame!.installFinish()
  }
  catch {
    // ⚠ Причин здесь ДВЕ, и вторая к порталу отношения не имеет. Либо портал не принял
    // сигнал, либо SDK отказал локально: при `!isInstallMode` `installFinish()` бросает
    // `JSSDK_FRAME_INSTALL_ALREADY_FINISHED` не отправляя ничего — то есть установка уже
    // завершена, и это не беда, а повтор. В обоих случаях у нас всё сохранено, поэтому
    // текст не про ошибку, а про то, что делать.
    stage.value = 'failed'
    failure.value = 'Установка у нас сохранена, но портал не подтвердил её завершение. '
      + 'Закройте окно и откройте приложение снова — если оно открылось, всё в порядке.'
  }
}

/**
 * Повтор — и он НЕ одинаковый в разных состояниях.
 *
 * ⚠ Из `partial` повторять установку нельзя: обмен гранта уже прошёл и ВРАЩАЕТ его,
 * то есть `refresh_token` во фрейме мёртв (SDK держит его в памяти с инициализации
 * и сам не обновляет). Повторный обмен гарантированно отказывал, и человек видел
 * «вы не администратор» вместо настоящей причины. Поэтому здесь доустройство
 * по уже сохранённым токенам, без обмена. Нашла панель ревью PR #27.
 *
 * ⚠ Без связи с порталом кнопки повтора нет вовсе: `frame` не получен, и нажатие
 * молча не делало бы ничего. Кнопка, которая выглядит рабочей и не работает, хуже
 * её отсутствия.
 */
async function retry() {
  if (frame === undefined || busy.value) return
  busy.value = true
  try {
    if (stage.value === 'partial') await finishProvisioning()
    else await install()
  }
  finally {
    busy.value = false
  }
}

/** Доустроить портал уже сохранёнными токенами: обмена гранта здесь нет. */
async function finishProvisioning() {
  const pass = readFramePass(frame!.auth.getAuthData())
  if (pass === null) {
    stage.value = 'failed'
    failure.value = 'Портал не передал данные авторизации. Переустановите приложение.'
    return
  }

  stage.value = 'installing'
  try {
    const result = await $fetch<{ ok: boolean, reason?: string }>('/api/portal/provision', {
      method: 'POST',
      body: { memberId: pass.memberId, authId: pass.authId },
    })
    if (result.ok) {
      stage.value = 'done'
      return
    }
    stage.value = 'partial'
    // ⚠ Три причины, а не две: нехватка прав приложения повтором не лечится вообще.
    // Совет «попробуйте ещё раз» на неё отправил бы администратора жать кнопку столько
    // раз, сколько у него терпения, — а чинится она галочкой в партнёрском кабинете.
    failure.value = REASONS[result.reason ?? ''] ?? 'Портал снова не дал создать смарт-процессы.'
  }
  catch {
    stage.value = 'partial'
    failure.value = 'Не удалось настроить портал. Попробуйте через несколько минут.'
  }
}
</script>

<template>
  <B24DashboardPanel id="install">
    <template #header>
      <B24DashboardNavbar
        :toggle="false"
        title="Установка приложения"
      />
    </template>

    <template #body>
      <B24Skeleton
        v-if="stage === 'starting' || stage === 'installing'"
        class="h-24 w-full"
      />

      <B24Alert
        v-else-if="stage === 'done'"
        color="air-primary-success"
        title="Приложение установлено"
        description="Смарт-процессы «Опрос» и «Шаблон опроса» созданы, вкладка «Опросы» появилась в карточке сделки. Можно закрывать это окно."
      />

      <template v-else-if="stage === 'partial'">
        <B24Alert
          color="air-primary-warning"
          title="Установлено, но настроено не до конца"
          description="Токены сохранены, приложение работает. А вот смарт-процессы на портале создать не удалось — чаще всего это значит, что приложение устанавливал не администратор. Переустановите его от имени администратора портала."
          class="mb-3"
        />
        <B24Button
          color="air-secondary-accent"
          :loading="busy"
          :disabled="busy"
          @click="retry"
        >
          Попробовать настроить ещё раз
        </B24Button>
      </template>

      <template v-else>
        <B24Alert
          color="air-primary-alert"
          title="Установка не завершилась"
          :description="failure"
          class="mb-3"
        />
        <!-- Без связи с порталом повторять нечем: `frame` не получен. Кнопку не показываем. -->
        <B24Button
          v-if="connected"
          color="air-primary"
          :loading="busy"
          :disabled="busy"
          @click="retry"
        >
          Попробовать ещё раз
        </B24Button>
      </template>
    </template>
  </B24DashboardPanel>
</template>
