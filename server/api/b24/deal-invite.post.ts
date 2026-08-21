// POST /api/b24/deal-invite — создать приглашение на опрос по сделке из виджета карточки сделки
// (#17, плейсмент CRM_DEAL_DETAIL_ACTIVITY — ручной запуск, охват на всех тарифах). Конвейер:
// rate-limit → parseFrameAuth → verifyFrameAuth (SSRF-allowlist → profile → сверка member_id) →
// crm.deal.get токеном виджета → dealToCrmContext → manualInvite (#176: «уже приглашали?» по открытым
// делам сделки → выписка → дело в таймлайне с маркером `manual:`) → ссылка /s/:key?token=… для
// адресата. Исходов ЧЕТЫРЕ: 200 со ссылкой; 200 + `alreadyInvited` («уже отправлено» / «клиент уже
// ответил» — не ошибка, человек всё сделал верно); 422 «опрос не опубликован»; 409 «портал исчез».
// Fail-closed: невалидный фрейм → 401.
// Своего кап-лимита на тело нет намеренно: его держит общий бэкстоп `server/middleware/body-limit.ts`
// (128 КБ → 413, тело без заявленной длины → 411) — ровно для таких роутов он и сделан. Раньше `readBody`
// здесь шёл до подтверждения фрейма вообще без ограничения.
import { PORTAL_GONE_MESSAGE } from '~core/api/session'
import { parseFrameAuth, verifyFrameAuth } from '~core/bitrix24/frame'
import { createPortalClient, dealGet, dealProductRows, frameToB24Params } from '~core/bitrix24/client'
import { dealToCrmContext } from '~core/bitrix24/deal-event'
import { surveyKeyForEntity } from '~core/bitrix24/survey-routing'
import { manualInvite } from '../../utils/manual-invite'
import { allowB24Session, useB24Authenticator } from '../../utils/b24-session'
import { b24AppConfig } from '../../utils/portal'
import { useSurveyRouting, logger } from '../../utils/api'
import { tenantByMemberId } from '../../utils/tenant'

// Какой опрос запускать по сделке — из конфигурации портала (env `SURVEY_KEY_DEAL`/`SURVEY_KEY_DEFAULT`),
// с дефолтом. UI-маппинг entityType→surveyKey — отдельный issue.

export default defineEventHandler(async (event) => {
  if (!allowB24Session(requestIp(event))) {
    setResponseStatus(event, 429)
    return { ok: false, error: 'Слишком много запросов. Подождите немного и попробуйте снова.' }
  }

  const body = await readBody(event).catch(() => ({}))
  const dealId = Number((body as { dealId?: unknown }).dealId)
  // Осознанное «всё равно создать новую ссылку» (#176). Сравниваем с `true`, а не приводим к
  // булеву: строка `"false"` из form-urlencoded иначе включила бы обход дедупа. Флаг присылает
  // КЛИЕНТ и только вторым нажатием — тем, что человек делает, уже зная про первое приглашение.
  const force = (body as { force?: unknown }).force === true
  // Откуда обход: `dedup` — человек увидел «уже приглашали» и всё равно нажал; `reissue` — виджет сам
  // предложил перевыписать мёртвую ссылку. Чужое значение отбрасываем: поле идёт только в лог, но
  // класть в него произвольную строку из тела запроса незачем.
  const rawReason = (body as { forceReason?: unknown }).forceReason
  const forceReason = rawReason === 'dedup' || rawReason === 'reissue' ? rawReason : undefined
  const frame = parseFrameAuth(body)
  if (!frame || !Number.isInteger(dealId) || dealId <= 0) {
    setResponseStatus(event, 400)
    return { ok: false, error: 'Не удалось определить сделку. Откройте виджет из карточки сделки.' }
  }

  // Анти-абьюз: подтверждаем портал (домен + живой токен + сверка member_id), как /api/b24/session.
  let portal
  try {
    portal = await verifyFrameAuth(frame, { authenticate: useB24Authenticator() })
  } catch {
    setResponseStatus(event, 401)
    return { ok: false, error: 'Портал не подтверждён. Откройте виджет заново из карточки сделки.' }
  }

  try {
    // crm.deal.get токеном пользователя виджета → снимок контекста.
    const client = createPortalClient(
      frameToB24Params({ domain: portal.domain, accessToken: frame.AUTH_ID, memberId: portal.portalId }),
      { clientId: process.env.NUXT_B24_CLIENT_ID ?? '', clientSecret: process.env.NUXT_B24_CLIENT_SECRET ?? '' }
    )
    const deal = await dealGet(client, dealId)
    // Товарные позиции — best-effort (у сделки товаров может не быть / нет доступа/скоупа): без них
    // срез дашборда «услуга/товар» пуст на реальных данных (сверено вебхуком). Ошибку глушим, но ЛОГИРУЕМ —
    // иначе систематический провал productrows (нет прав/скоупа) → тихо пустой срез без диагностики.
    const productRows = await dealProductRows(client, dealId).catch((e: unknown) => {
      logger.warn('b24_deal_productrows_fail', { msg: `Сделка ${dealId}: ${(e as Error).message}` })
      return []
    })
    const context = dealToCrmContext(deal, productRows)

    // TENANT (#49): стор и приглашения — портала, ПОДТВЕРЖДЁННОГО выше (`verifyFrameAuth`: домен из
    // allowlist → живой `profile` → сверка member_id с сохранённым). Раньше стор был один на процесс,
    // и виджет одного заказчика создавал бы приглашение в данных другого.
    const tenant = await tenantByMemberId(portal.portalId)
    if (!tenant) {
      // Портал подтверждён, а строки нет: приложение удалили прямо сейчас. Отдельный текст, потому
      // что «опрос не опубликован» здесь было бы неправдой и увело бы настраивать опрос. ⚠️ Совет
      // адресован ТОМУ, КТО ЧИТАЕТ: виджет открывает продавец из карточки сделки, а установка
      // приложения ему недоступна — «установите заново» он выполнить не может.
      setResponseStatus(event, 409)
      return { ok: false, error: PORTAL_GONE_MESSAGE }
    }
    const { routing, fallback } = useSurveyRouting()
    const surveyKey = surveyKeyForEntity('deal', routing, fallback)
    // База ссылки — из ЕДИНОЙ точки (b24AppConfig: APP_DOMAIN ?? DOMAIN), как HANDLER-URL встроек.
    // Раньше бралось только из DOMAIN → деплой на APP_DOMAIN давал относительный URL, который внутри
    // iframe-виджета разрешался бы на домен портала Bitrix (битая ссылка клиенту).
    const base = b24AppConfig()?.baseUrl ?? ''
    // ⚠️ Выписка — отдельным модулем (#176): там она исполняется тестами («уже висит открытое дело →
    // второй ссылки нет», «отказ создания дела не отбирает ссылку у человека»), а замыкание внутри
    // роута проверить было нечем. Раньше здесь стоял голый `createSurveyInvitation`: ни поиска
    // открытых дел, ни записи в таймлайн — вторая ссылка появлялась молча и в дедупе не участвовала.
    const res = await manualInvite(
      { dealId, surveyKey, context, ...(force ? { force } : {}), ...(forceReason ? { forceReason } : {}) },
      {
        client,
        portalId: portal.portalId,
        store: tenant.store,
        invitations: tenant.invitations,
        baseUrl: base,
        log: logger
      }
    )
    if (res.kind === 'unpublished') {
      setResponseStatus(event, 422)
      return { ok: false, error: 'Опрос ещё не опубликован. Опубликуйте его в разделе «Опросы» и повторите.' }
    }
    if (res.kind === 'existing' || res.kind === 'answered') {
      // ⚠️ Не ошибка и не 4xx: человек сделал всё правильно, просто спрашивать больше нечего.
      // Отдельный флаг, а не текст в `error`, — виджету нужно решить, показывать ли кнопку «всё
      // равно создать новую», а разбирать для этого строку он не должен.
      // ⚠️ Текст ведёт к КОНКРЕТНОМУ действию, которое уже работает: у дела в таймлайне есть кнопка
      // «Отправить приглашение», и она открывает виджет с готовой ссылкой (#126). Отправлять «куда-то
      // в таймлайн» значило бы сделать правильный путь дороже неправильного — а неправильный стоит
      // одно нажатие рядом.
      const deal = res.surveyTitle ? `«Опрос: ${res.surveyTitle}»` : 'с опросом'
      return {
        ok: false,
        alreadyInvited: true,
        error: res.kind === 'answered'
          ? 'Клиент уже прошёл этот опрос по данной сделке. Новая ссылка нужна, только если хотите спросить ещё раз.'
          : `Приглашение по этой сделке уже отправлено. Откройте в таймлайне сделки дело ${deal} и нажмите в нём «Отправить приглашение» — там готовая ссылка.`
      }
    }
    logger.info('b24_deal_invite', { msg: `Приглашение по сделке ${dealId} (портал ${portal.portalId})` })
    // ⚠️ `activityMissing` — не деталь реализации, а то, что человеку надо знать: ссылка у него на
    // руках, но записи в таймлайне нет, значит следующее нажатие о ней не узнает и ответ клиента её
    // не закроет. Молчать здесь значило бы вернуть «невидимую вторую ссылку», от которой весь #176.
    return {
      ok: true,
      surveyKey: res.surveyKey,
      token: res.token,
      url: res.url,
      ...(res.activityId === undefined ? { activityMissing: true } : {})
    }
  } catch (e) {
    logger.warn('b24_deal_invite_fail', { msg: `Сделка ${dealId}: ${(e as Error).message}` })
    setResponseStatus(event, 502)
    return { ok: false, error: 'Не удалось создать ссылку на опрос. Проверьте доступ к сделке и попробуйте снова.' }
  }
})
