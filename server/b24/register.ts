import { sql } from 'drizzle-orm'
import { makePortalCall } from './client'
import { ensureDealTabPlacement, ensureTemplateTabPlacement, isPortalAdmin, storeProvisionRevision, provisionSmartProcesses, readStoredRefs, storeRefs, withDeadline } from './provision'
import type { RestCall } from './provision'
import { getDb, schema } from '../db/client'
import { saveRefreshedTokens } from '../links/issue'
import type { RegisterPortal } from '../domain/portals/install'
import { applyProvisionStatus } from '../portals/store'
import { PROVISION_REVISION } from '../domain/portals/smart-processes'
import { buildTabHandlerUrl } from '../domain/portals/placements'
import { SURVEY_RESULT_HANDLER_PATH } from '../domain/portals/userfield-type'
import { REQUIRED_SCOPES, looksLikeScopeRefusal } from '../domain/portals/scopes'
import { publicBaseUrl } from '../utils/env'
import { encryptSecret } from '../utils/crypto'
import { logger } from '../utils/logger'

/**
 * Persists a verified portal and provisions it.
 *
 * Вынесено из `server/api/install.post.ts`, когда путей установки стало ДВА: событие
 * `ONAPPINSTALL` и мастер установки во фрейме портала (`app/pages/install.vue`). Разбор
 * входящего у них разный — бракетная форма тела против данных фрейма, — а вот что делать
 * с подтверждённым грантом обязано быть одним куском кода. Порядок «сначала токены, потом
 * обустройство» и перевод в `degraded` при неудаче стоят ровно столько, сколько стоит
 * однажды переставить их местами в одной из двух копий.
 */

/**
 * Бюджет времени на всё обустройство.
 *
 * Холодная установка — 17–19 вызовов подряд под троттлингом SDK, это единицы секунд
 * на здоровом портале. Сорок пять секунд — четырёхкратный запас и при этом заведомо
 * меньше таймаута общего `nginx-proxy`.
 */
const PROVISION_BUDGET_MS = 45_000

/**
 * Записать портал и обустроить его.
 *
 * ⚠ Порядок не переставляется. Токены — то, без чего нельзя вообще ничего, и они пишутся
 * первыми. Смарт-процессы создаются повторно без вреда, а вот второй попытки сохранить
 * токены может не быть: событие установки, скорее всего, не повторяется, а мастер
 * администратор просто закроет.
 */
export async function registerPortal(portal: RegisterPortal): Promise<'ok' | 'degraded'> {
  const now = new Date()
  // ⚠ Шифротекст считается ОДИН раз и запоминается: шифрование рандомизировано, и повторный
  // `encryptSecret` того же токена даёт другую строку. Дальше он нужен как исходное значение
  // для compare-and-swap при продлении — сравнивать надо ровно с тем, что легло в колонку.
  const storedRefreshToken = encryptSecret(portal.refreshToken)
  const rows = await getDb()
    .insert(schema.portals)
    .values({
      memberId: portal.memberId,
      domain: portal.domain,
      accessToken: encryptSecret(portal.accessToken),
      refreshToken: storedRefreshToken,
      // ⚠ NULL, а не шифротекст пустой строки. `encryptSecret('')` даёт непустую строку,
      // и по ней потом не отличить «токена не приносили» от «приносили пустой» — а именно
      // на этом отличии держится защита ниже.
      applicationToken: portal.applicationToken === '' ? null : encryptSecret(portal.applicationToken),
      tokenExpiresAt: new Date(now.getTime() + portal.expiresInSeconds * 1000),
      scopes: portal.scope,
      status: 'active',
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.portals.memberId,
      // Переустановка на тот же портал — обычное дело: сменилась версия, администратор
      // переставил приложение. Это UPDATE, а не новая запись: иначе к порталу потеряются
      // все привязанные ссылки и буфер.
      set: {
        domain: sql`excluded.domain`,
        accessToken: sql`excluded.access_token`,
        refreshToken: sql`excluded.refresh_token`,
        // Перезаписывается при переустановке СОБЫТИЕМ: портал выдаёт новый токен,
        // и сохранённый старый сделал бы непроверяемым каждое следующее событие.
        //
        // ⚠ Но пустым НЕ затирается. У мастера установки этого токена нет вовсе — фрейм его
        // не отдаёт, — и безусловная перезапись превращала бы уже полученный событием токен
        // в пустую строку при первой же переустановке через мастер. Молча: ни ошибки,
        // ни строки в журнале. Защита была чисто процессной («не забыть перед первой
        // подпиской»); теперь она техническая. Нашла панель ревью PR #27.
        applicationToken: sql`coalesce(excluded.application_token, ${schema.portals.applicationToken})`,
        tokenExpiresAt: sql`excluded.token_expires_at`,
        // ⚠ Отметка мёртвого гранта снимается переустановкой, и без этой строки механизм
        // отмирания портала ломал сам себя. `ON CONFLICT DO UPDATE` не трогает колонки,
        // которых нет в списке, — то есть портал, помеченный или уже стёртый, возвращался бы
        // к жизни со свежими токенами И со старой, давно просроченной отметкой. Первый же
        // тик уборщика (раз в минуту) стирал бы только что выданные токены, и спасти их
        // не успевало бы ничто: снять отметку может только продление, а оно не раньше чем
        // через час. Клиент переустанавливает приложение, оно «не запоминается», и понять
        // это без похода в базу нельзя. Подтверждённая переустановка и есть тот успех,
        // который обязан снимать отметку. Нашла панель ревью PR #34.
        grantRevokedAt: sql`null`,
        scopes: sql`excluded.scopes`,
        status: sql`excluded.status`,
        updatedAt: sql`excluded.updated_at`,
      },
    })
    .returning({ id: schema.portals.id })

  const portalId = rows[0]!.id
  logger.info({ domain: portal.domain }, 'токены портала сохранены')

  // Смарт-процессы создаём ПОСЛЕ сохранения токенов и не роняем ими установку.
  // Токены — то, без чего нельзя вообще ничего; смарт-процессы можно создать повторно,
  // а вот второго события установки не будет. Поэтому здесь портал уже установлен,
  // а неудача обустройства переводит его в `degraded`.
  //
  // ⚠ `degraded` теперь ЧИТАЕТСЯ: фоновое долечивание перечитывает такие порталы раз в час
  // и пробует обустроить их снова сохранёнными токенами (`server/portals/heal.ts`, issue #12).
  // До этого статус не читала ни одна строка кода, и застрявший портал чинился только
  // переустановкой руками — о необходимости которой администратору никто не говорил.
  const outcome = await provisionPortal({ ...portal, id: portalId, storedRefreshToken })
  await applyProvisionStatus(portalId, outcome)
  if (outcome !== 'ok') {
    logger.warn({ domain: portal.domain, outcome }, 'портал установлен, но не обустроен')
  }

  return outcome === 'ok' ? 'ok' : 'degraded'
}

/**
 * Создать на портале смарт-процессы и поля.
 *
 * Права администратора проверяются ЗДЕСЬ, при установке, а не когда метод понадобится:
 * без них не создать ни смарт-процесс, ни поле, ни записать настройки (`app.option.set`
 * отвечает «Administrator authorization required»). Узнать об этом в момент, когда
 * сотрудник уже ждёт ссылку, — худший из вариантов.
 */
async function provisionPortal(portal: {
  id: string
  memberId: string
  domain: string
  accessToken: string
  refreshToken: string
  /** Шифротекст, который лёг в колонку: исходное значение для compare-and-swap. */
  storedRefreshToken: string
  applicationToken: string
  expiresInSeconds: number
  scope: string[]
}): Promise<'ok' | 'not-admin' | 'no-scope' | 'failed'> {
  // ⚠ Здесь НЕТ предварительной проверки разрешений по `portal.scope`, и это вывод
  // из живого портала, а не упущение. PR #30 такую проверку завёл — и она была бы
  // неверной: на `b24-ypkv9c.bitrix24.by` сохранённый `scopes` равен `{app}`, при том
  // что установка на нём прошла целиком, то есть `crm.type.add`, `userfieldconfig.add`
  // и `placement.bind` отработали. Значит `scope` в ответе сервера авторизации при
  // обмене по `refresh_token` НЕ перечисляет выданные приложению права, и решать
  // по нему «нам не хватит прав» — значит запрещать установку работающему порталу.
  // Разбор — в `docs/PROCESS.md`.
  //
  // Настоящий источник правды о правах — сам портал: недостающий scope он называет
  // кодом `insufficient_scope`, и этот случай разобран в `provisionWithCall` ниже.
  const caller = makePortalCall(
    {
      memberId: portal.memberId,
      domain: portal.domain,
      accessToken: portal.accessToken,
      refreshToken: portal.refreshToken,
      applicationToken: portal.applicationToken,
      expiresIn: portal.expiresInSeconds,
      scope: portal.scope,
    },
    // ⚠ Через ОБЩИЙ `saveRefreshedTokens`, а не своим `UPDATE`. Здесь стояла собственная
    // копия записи — без compare-and-swap по прежней паре и без условия `status <> 'deleted'`,
    // то есть в обход обеих защит, которые ради этих же гонок и заводились. Комментарий
    // при этом обещал «не воскресит удалённый портал»: до появления стирания это было верно,
    // а с ним стало неправдой. Обустройство — это 17–19 вызовов под бюджетом в 45 секунд,
    // и продление посреди них вполне реально. Нашла панель ревью PR #34.
    async next => saveRefreshedTokens(portal.id, {
      accessToken: encryptSecret(next.accessToken),
      refreshToken: encryptSecret(next.refreshToken),
      expiresAt: new Date(Date.now() + next.expiresIn * 1000),
      previousRefreshToken: portal.storedRefreshToken,
    }),
  )

  return provisionWithCall(caller.call, portal.domain)
}

/**
 * Обустроить портал уже готовым вызовом.
 *
 * Вынесено, когда вызывающих стало двое: установка (и событием, и мастером) и ДОУСТРОЙСТВО
 * по уже сохранённым токенам (`server/api/portal/provision.post.ts`). Второй нужен потому,
 * что повторить установку с тем же грантом нельзя — обмен его вращает, — а состояние
 * «токены сохранены, смарт-процессы нет» обязано иметь выход, не требующий переустановки
 * приложения целиком. Нашла панель ревью PR #27.
 *
 * Идемпотентно: смарт-процессы ищутся по сохранённым идентификаторам и по заголовку,
 * поля добавляются только недостающие, вкладка перерегистрируется.
 */
export async function provisionWithCall(call: RestCall, domain: string): Promise<'ok' | 'not-admin' | 'no-scope' | 'failed'> {
  const portal = { domain }
  const budgeted = withDeadline(call, PROVISION_BUDGET_MS)

  try {
    if (!await isPortalAdmin(budgeted)) return 'not-admin'

    const known = await readStoredRefs(budgeted)
    // Адрес виджета уходит внутрь: поле своего типа заводится ДО раскладки карточки,
    // а раскладка — часть обустройства смарт-процессов. Почему именно в таком порядке —
    // у самого шага в `provisionSmartProcesses`.
    const resultHandlerUrl = buildTabHandlerUrl(publicBaseUrl(), SURVEY_RESULT_HANDLER_PATH)
    const result = await provisionSmartProcesses(budgeted, known, resultHandlerUrl)
    await storeRefs(budgeted, { template: result.template, survey: result.survey })

    if (result.adoptedTemplate || result.adoptedSurvey) {
      // Взяли на портале смарт-процесс, которого не создавали. Обычно это наш же,
      // переживший переустановку, — но отличить его от чужого одноимённого нечем,
      // а поля мы теперь пишем в него. Пусть след останется.
      logger.warn(
        { domain: portal.domain, adopted: [result.adoptedTemplate, result.adoptedSurvey] },
        'смарт-процесс найден по заголовку, а не создан нами',
      )
    }

    // Вкладка регистрируется ПОСЛЕ смарт-процессов и отдельным вызовом: `placement.bind`
    // не кладётся в батч, а вкладка без смарт-процессов показала бы менеджеру пустой экран.
    // Её отказ установку не роняет — без вкладки приложение работает, без токенов нет.
    const placed = await ensureDealTabPlacement(budgeted, publicBaseUrl())
    if (!placed) {
      logger.warn({ domain: portal.domain }, 'вкладка в карточке сделки не зарегистрирована')
    }

    // ⚠ Вторая вкладка — конструктор анкеты в карточке «Шаблона опроса». Код точки собирается
    // из `entityTypeId`, а НЕ из `id` смарт-процесса: соседний механизм, имена полей, берёт
    // как раз `id`, и перепутать их — вопрос одной буквы. Разбор в `templateTabPlacement`.
    const builderPlaced = await ensureTemplateTabPlacement(
      budgeted,
      publicBaseUrl(),
      result.template.entityTypeId,
    )
    if (!builderPlaced) {
      logger.warn({ domain: portal.domain }, 'вкладка конструктора не зарегистрирована')
    }

    // Отказ поля своего типа установку не роняет: без виджета результат виден прежними
    // JSON-полями, просто хуже. Но «виджета нет» должно узнаваться из журнала, а не от клиента.
    if (!result.resultField) {
      logger.warn({ domain: portal.domain }, 'поле «Результат опроса» не заведено — в карточке остаётся JSON')
    }

    if (!result.dealLinked) {
      // ⚠ Приложение установилось, но главного не делает: элемент «Опрос» не привяжется
      // к сделке, и итог не вернётся в карточку. Чаще всего это тариф, запрещающий правку
      // смарт-процессов. Громко — потому что месяц этот исход был вообще невидимым.
      logger.error(
        { domain: portal.domain },
        'связь «Опроса» со сделкой не настроена: итог опроса НЕ попадёт в карточку сделки',
      )
    }

    // ⚠ Отметка ревизии — ПОСЛЕДНИМ шагом, после вкладок. Записав её раньше, мы объявили бы
    // портал настроенным до того, как настроили: следующая фоновая проверка сочла бы его
    // свежим и вкладку регистрировать не стала бы. Issue #75.
    await storeProvisionRevision(budgeted, { template: result.template, survey: result.survey })

    logger.info(
      {
        domain: portal.domain,
        revision: PROVISION_REVISION,
        created: [result.createdTemplate, result.createdSurvey],
        addedFields: result.addedFields,
        placed,
        builderPlaced,
        resultField: result.resultField,
        dealLinked: result.dealLinked,
        cardConfigured: result.cardConfigured,
      },
      'смарт-процессы обустроены',
    )
    return 'ok'
  }
  catch (error) {
    const reason = (error as Error).message
    // ⚠ Отказ по правам отделяем от прочих: лечится он галочкой в партнёрском кабинете,
    // а не повтором через минуту, и перепутать эти два совета дорого — администратор
    // будет жать «попробовать ещё раз» ровно столько раз, сколько у него терпения.
    // Портал — единственный, кто знает правду о правах: предсказать её по `scope`
    // из ответа сервера авторизации нельзя, см. комментарий в `provisionPortal`.
    if (looksLikeScopeRefusal(reason)) {
      logger.error({ domain: portal.domain, required: [...REQUIRED_SCOPES] }, 'порталу не хватает прав приложения')
      return 'no-scope'
    }
    logger.error({ domain: portal.domain, reason }, 'обустройство портала не удалось')
    return 'failed'
  }
}
