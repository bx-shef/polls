import { drainInbox, requeueStuck } from '../answers/deliver'
import { isDatabaseConfigured } from '../db/client'
import { purgeDeadPortals } from '../portals/store'
import { deliveryDisabled, deliveryIntervalSeconds } from '../utils/env'
import { logger } from '../utils/logger'

/**
 * Runs the answer-delivery loop inside the app process.
 *
 * Отдельного воркера пока нет намеренно. Объём работы — единицы ответов в день на портал,
 * и второй контейнер ради этого означал бы второй образ, второй деплой и второе место,
 * где кончаются токены. `FOR UPDATE SKIP LOCKED` делает цикл безопасным при нескольких
 * экземплярах приложения, поэтому вынести его в отдельный процесс можно будет позже,
 * не переписывая: достаточно поднять тот же образ с `ANSWER_DELIVERY=off` у веб-части.
 *
 * ⚠ Цикл не ждёт своего срабатывания после приёма ответа: страница дёргает разбор сразу,
 * и в норме ответ уезжает в портал за секунды. Интервал здесь — страховка на случай,
 * когда портал был недоступен и попытку отложили.
 */
export default defineNitroPlugin(() => {
  if (deliveryDisabled()) {
    logger.info({}, 'доставка ответов выключена в этом процессе (ANSWER_DELIVERY=off)')
    return
  }
  if (!isDatabaseConfigured()) {
    // Без базы буфера нет вовсе. Молчать нельзя: снаружи это выглядит как «ответы копятся».
    logger.warn({}, 'доставка ответов не запущена: база не настроена')
    return
  }

  const intervalMs = deliveryIntervalSeconds() * 1000
  let running = false

  const tick = async () => {
    // Захода на заход не наслаиваем: медленный портал иначе накопил бы столько параллельных
    // разборов, сколько прошло тиков, и добил бы себя же.
    if (running) return
    running = true
    try {
      await requeueStuck()
      const result = await drainInbox()
      if (result.delivered > 0 || result.failed > 0) logger.info(result, 'разбор буфера ответов')

      // ⚠ Уборщик мёртвых порталов висит на ЭТОМ тике, а не на своём таймере. Своего
      // не завели намеренно: второй таймер — это второе место, где цикл может не запуститься,
      // и второй же набор гвардов на «а он вообще тикает». Работы у уборщика на пустом
      // множестве ровно один индексный запрос раз в минуту.
      //
      // Порог — две недели молчания портала, см. `server/domain/portals/lifecycle.ts`.
      const purged = await purgeDeadPortals(new Date())
      if (purged > 0) logger.warn({ purged }, 'стёрты порталы с мёртвым грантом')
    }
    catch {
      // Упавший тик не должен уносить цикл: следующий разберётся.
      //
      // ⚠ Причина не записывается, и это не лень. Ниже по стеку лежат вызовы портала,
      // в параметрах которых едет ответ клиента, а Битрикс24 любит цитировать присланное
      // значение в тексте ошибки валидации. Свои отказы разбор записывает сам и безопасно
      // (`server/domain/answers/portal-errors.ts`); сюда доходит только то, что он не поймал.
      logger.error({}, 'разбор буфера ответов сорвался')
    }
    finally {
      running = false
    }
  }

  const timer = setInterval(() => void tick(), intervalMs)
  // `unref` — чтобы таймер не держал процесс живым при остановке контейнера.
  timer.unref?.()

  logger.info({ intervalSeconds: deliveryIntervalSeconds() }, 'доставка ответов запущена')
})
