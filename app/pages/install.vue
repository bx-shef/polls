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

type Stage = 'starting' | 'installing' | 'done' | 'partial' | 'failed'

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

onMounted(async () => {
  try {
    frame = await initializeB24Frame()
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
    // Портал не принял сигнал. Установка при этом состоялась у нас, поэтому текст
    // не про ошибку, а про то, что делать.
    stage.value = 'failed'
    failure.value = 'Портал не принял завершение установки. Закройте окно и откройте приложение снова.'
  }
}

async function retry() {
  if (frame === undefined) return
  await install()
}
</script>

<template>
  <B24App>
    <div class="p-4">
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
        <B24Button
          color="air-primary"
          @click="retry"
        >
          Попробовать ещё раз
        </B24Button>
      </template>
    </div>
  </B24App>
</template>
