import type { PortalClient } from './client'
import { callMethod } from './client'
import type { ResultLine } from '../domain/result-summary'
import { INVITE_ORIGINATOR, markerMatchesSurvey, type InviteMarker, type MarkedActivity, type MarkerFix } from './invite-delivery'
import { inviteActionParams, resultActionParams } from '../client/widget-params'

/**
 * Доставка приглашения на опрос через НАСТРАИВАЕМОЕ ДЕЛО таймлайна сделки
 * (`crm.activity.configurable.add`, Фаза F). Чистый билдер параметров активности +
 * тонкая REST-обёртка. Виджет `CRM_DEAL_DETAIL_ACTIVITY` (кнопка «Отправить приглашение»
 * → `bindLayoutEventCallback`) и авто-постинг на триггере — отдельные срезы (нужен живой
 * портал/визуальный гейт), трекинг — **#126**. Здесь — framework-agnostic ядро под тестами.
 *
 * Структура `layout`/`fields` сверена с REST-контрактом Bitrix24 (apidocs, timeline/activities/
 * configurable) И с **live-verified** билдером соседнего проекта `ai-price-import`
 * (`server/utils/configurableActivity.ts`, проверен на реальном OAuth-портале). Ключевые инварианты
 * оттуда: `body.logo` ОБЯЗАТЕЛЕН (без него Bitrix отвергает: «Поле logo в BodyDto должно быть
 * заполнено»); `logo.code` — из системного enum `crm.timeline.logo.list` (`document` валиден);
 * `redirect.uri` — ТОЛЬКО same-portal относительный путь (иначе off-portal redirect / SSRF); блоков
 * тела 1..20, кнопок футера ≤2.
 */

/** CRM owner type сделки (`CCrmOwnerType::Deal`). Активность-опрос крепится к сделке (виджет
 *  карточки сделки). Мульти-сущность (lead=1/contact=3/company=4/spa=`entityTypeId`) — follow-up. */
export const DEAL_OWNER_TYPE_ID = 2

/** Код логотипа/иконки активности из системного enum `crm.timeline.logo.list`. `document` подтверждён
 *  живьём как валидный (сосед `ai-price-import`). ⚠️ Опрос-специфичный код — сверить на живом портале
 *  (`crm.timeline.logo.list`); невалидный код Bitrix отвергает. */
export const SURVEY_ACTIVITY_LOGO = 'document'

/** Путь карточки сделки в портале — same-portal относительный (открывается ВНУТРИ Bitrix, без SSRF:
 *  строится из ЧИСЛОВОГО id, схемы/протокол-относительного `//host` быть не может). */
export function dealDetailPath(dealId: number): string {
  return `/crm/deal/details/${dealId}/`
}

/**
 * Нейтрализация разметки в тексте, попадающем в таймлайн Bitrix: скобки `[`/`]` → полноширинные
 * `［`/`］` (BB-код: `[url=…]`, метки, кнопки) и `<`/`>` → `＜`/`＞`.
 *
 * Порт live-verified паттерна соседа `ai-price-import` (`chatNotify.neutralizeBb`). Длину строки не
 * меняет (замена 1:1), поэтому применяется ДО `.slice`.
 *
 * ⚠️ Угловые скобки добавлены с возвратом РЕЗУЛЬТАТА в таймлайн (#18): `surveyTitle` авторит админ
 * портала (тот же домен доверия), а вот сводка ответов несёт СВОБОДНЫЙ ТЕКСТ анонимного респондента —
 * текстовый вопрос и «Другое». Рендерит ли Bitrix24 блок `type: 'text'` как разметку, вживую не
 * сверено; окажись что да — `<img onerror=…>` из чужого ответа попал бы в CRM менеджера. Проверка
 * стоит ноль, а ставка на «наверняка экранирует» — чужая CRM.
 */
export function neutralizeBb(text: string): string {
  return String(text ?? '')
    .replace(/\[/g, '［').replace(/\]/g, '］')
    .replace(/</g, '＜').replace(/>/g, '＞')
}

export interface SurveyInviteActivityInput {
  /** id сделки, в таймлайн которой кладём активность. */
  dealId: number
  /** Заголовок опроса — в шапку активности. */
  surveyTitle: string
  /** Стабильный ключ опроса — уходит в `actionParams` кнопки (виджет знает, что слать). */
  surveyKey: string
  /** Токен приглашения — основа ссылки `/s/:key?token=…` и параметр отправки. */
  token: string
  /** Абсолютная ссылка на анкету (наш внешний домен) — сохраняется в деле ТЕКСТОМ (не redirect:
   *  `redirect` навигирует внутри портала, внешний URL туда класть нельзя). */
  surveyUrl: string
  /** Ответственный за активность (опц.) — сотрудник, ведущий сделку. */
  responsibleId?: number
  /** Маркер идемпотентности: по нему дело ищется перед созданием следующего (#138). */
  marker?: InviteMarker
}

/** Параметры `crm.activity.configurable.add` (по REST-контракту Bitrix24 + live-verified сосед). */
export interface ConfigurableActivityParams {
  ownerTypeId: number
  ownerId: number
  fields: {
    typeId: string
    completed: 'Y' | 'N'
    responsibleId?: number
    /**
     * Маркер идемпотентности (#138): по нему дело потом ищется. `crm.activity` эти поля точно имеет
     * и фильтрует по ним (проверено на живом портале); принимает ли их `configurable.add` в своём
     * `fields` — станет известно только на установленном приложении, поэтому после создания маркер
     * СВЕРЯЕТСЯ и при отсутствии дописывается (`ensureActivityMarker`).
     */
    originatorId?: string
    originId?: string
  }
  layout: {
    icon: { code: string }
    header: { title: string }
    body: {
      logo: { code: string; action: { type: string; uri: string } }
      blocks: Record<string, unknown>
    }
    /**
     * Футер с кнопками. Необязателен, и это не формальность: у дела-приглашения кнопка есть всегда, у
     * дела-РЕЗУЛЬТАТА — только когда известна запись ответа (#18), иначе открывать ей нечего. Правило
     * одно: мёртвая кнопка хуже отсутствующей.
     */
    footer?: { buttons: Record<string, unknown> }
  }
}

/**
 * Собрать параметры настраиваемой активности «Опрос» для таймлайна сделки. Шапка — название опроса;
 * тело — ссылка на анкету (текстом, оператор видит/копирует) + обязательный `logo` (клик открывает
 * сделку); футер — кнопка «Отправить приглашение» (`openRestApp`: наш виджет ловит клик через
 * `bindLayoutEventCallback` и шлёт приглашение выбранным каналом). Чистая функция — тестируется без
 * портала; фактический REST-вызов делает `activityConfigurableAdd`.
 */
export function buildSurveyInviteActivity(input: SurveyInviteActivityInput): ConfigurableActivityParams {
  const dealPath = dealDetailPath(input.dealId)
  return {
    ownerTypeId: DEAL_OWNER_TYPE_ID,
    ownerId: input.dealId,
    fields: {
      // typeId по умолчанию CONFIGURABLE (задаём явно — самодокументируемо); completed=N → активность
      // висит как невыполненный call-to-action, пока приглашение не отправлено (⚠️ поведение открытой
      // активности без deadline/responsibleId — в чек-лист живого smoke).
      typeId: 'CONFIGURABLE',
      completed: 'N',
      ...(input.responsibleId != null ? { responsibleId: input.responsibleId } : {}),
      ...(input.marker ? { originatorId: input.marker.originatorId, originId: input.marker.originId } : {})
    },
    layout: {
      icon: { code: SURVEY_ACTIVITY_LOGO },
      // BB-нейтрализация + кап длины (защита от инъекции в таймлайн и раздувания payload).
      header: { title: neutralizeBb(`Опрос: ${input.surveyTitle}`).slice(0, 255) },
      body: {
        // logo (LogoDto) ОБЯЗАТЕЛЕН — иначе Bitrix отвергает (live-verified). Клик по логотипу
        // открывает сделку (same-portal относительный путь из числового id — SSRF-safe).
        logo: { code: SURVEY_ACTIVITY_LOGO, action: { type: 'redirect', uri: dealPath } },
        // 1..20 блоков. Ссылка на анкету — ТЕКСТОМ (URL внешний, наш домен; redirect навигирует внутри
        // портала и на внешний хост его класть нельзя). Оператор видит/копирует ссылку; отправляет клиенту
        // кнопкой ниже. BB-нейтрализация + кап длины (URL всегда короче — кап лишь backstop).
        blocks: {
          surveyLink: { type: 'text', properties: { value: neutralizeBb(input.surveyUrl).slice(0, 500) } }
        }
      },
      footer: {
        buttons: {
          sendInvite: {
            title: 'Отправить приглашение',
            type: 'primary',
            action: {
              // openRestApp открывает наш плейсмент-виджет с actionParams — он и выполняет отправку
              // ссылки клиенту (email/sms по channelOrder). Токен/ключ/сделка — минимально нужный контекст.
              // ⚠️ Тип действия `openRestApp` у футер-кнопки вживую НЕ сверен (сосед live-verified только
              // `redirect`) — валидность `openRestApp`/`actionParams` в чек-листе живого smoke #126.
              // Имена параметров собирает ОБЩИЙ хелпер — их же читает виджет (иначе расхождение имён
              // молча приведёт ко второму приглашению, см. JSDoc `inviteActionParams`).
              type: 'openRestApp',
              actionParams: inviteActionParams({
                dealId: input.dealId,
                surveyKey: input.surveyKey,
                token: input.token,
                // Ровно та ссылка, что записана текстом в теле дела: иначе менеджер увидит одну, а
                // скопирует из виджета другую (домен приложения vs origin iframe).
                url: input.surveyUrl
              })
            }
          }
        }
      }
    }
  }
}

export interface SurveyResultActivityInput {
  /** id сделки, в таймлайн которой кладём результат. */
  dealId: number
  /** Заголовок опроса — в шапку активности. */
  surveyTitle: string
  /** Сводка ответов клиента (`summarizeResponse`) — строки «вопрос → значение». */
  lines: readonly ResultLine[]
  /** Маркер записи: `result:<responseId>` (`resultMarker`) — по нему дело потом находят. */
  marker?: InviteMarker
  /**
   * Идентификатор записи ответа — уезжает в `actionParams` кнопки «Открыть результат» (#18).
   *
   * ⚠️ Тот же, из которого построен `marker`, но берётся ОТДЕЛЬНЫМ полем, а не разбором маркера:
   * форма маркера — деталь дедупа, и вытаскивать из неё идентификатор значило бы связать кнопку с
   * формой ключа. Поменяется форма (а она уже менялась дважды) — кнопка сломается молча.
   */
  responseId?: string
  /** Ответственный за активность (опц.). */
  responsibleId?: number
}

/**
 * Собрать параметры активности «Результат опроса» для таймлайна сделки (триггер «клиент заполнил
 * опрос», #18) — симметрично `buildSurveyInviteActivity`. Отличия: `completed:'Y'` (это ЗАПИСЬ о
 * завершённом опросе, не pending-действие); тело — сводка ответов клиента (по блоку на строку);
 * футер — кнопка **«Открыть результат»** при непустом `responseId` (разбор — в самом `layout` ниже).
 * До страницы результата футера здесь не было намеренно: вести кнопке было некуда, а кнопка в пустой
 * экран хуже её отсутствия. Пустая сводка → один блок-заглушка (Bitrix требует ≥1 блок). Чистая
 * функция — тестируется без портала.
 */
export function buildSurveyResultActivity(input: SurveyResultActivityInput): ConfigurableActivityParams {
  const dealPath = dealDetailPath(input.dealId)
  // ≥1 блок (инвариант Bitrix) и ≤20: `slice(0,20)` — жёсткий гейт независимо от `maxLines` summarizeResponse;
  // заглушка на пустую сводку (пустой `blocks` Bitrix отверг бы).
  const lineEntries = input.lines.length > 0 ? input.lines.slice(0, 20) : [{ label: 'Опрос заполнен', value: 'без ответов' }]
  const blocks: Record<string, unknown> = {}
  lineEntries.forEach((line, i) => {
    // ⚠️ Метку капаем ОТДЕЛЬНО. `summarizeResponse` капает только значение (300), а текст вопроса
    // схема разрешает до 2000 — на общей обрезке в 500 вопрос длиной 500+ съедал бы ответ целиком, и
    // в таймлайн уходила бы обрезанная формулировка без единого символа того, что клиент ответил.
    // ⚠️ Режем по КОД-ПОИНТАМ, а не по единицам UTF-16: свободный текст с эмодзи ровно на границе
    // дал бы одиночный суррогат — в лучшем случае «крякозябра» в карточке, в худшем портал отверг бы
    // payload, и результат потерялся бы тихо (путь best-effort, наружу отказ не идёт).
    const label = [...neutralizeBb(line.label)].slice(0, 180).join('')
    const value = [...neutralizeBb(line.value)].slice(0, 300).join('')
    blocks[`line${i}`] = { type: 'text', properties: { value: `${label}: ${value}` } }
  })
  return {
    ownerTypeId: DEAL_OWNER_TYPE_ID,
    ownerId: input.dealId,
    fields: {
      // completed=Y — активность-ЗАПИСЬ о завершённом опросе (в отличие от pending-приглашения completed=N).
      typeId: 'CONFIGURABLE',
      completed: 'Y',
      ...(input.responsibleId != null ? { responsibleId: input.responsibleId } : {}),
      ...(input.marker ? { originatorId: input.marker.originatorId, originId: input.marker.originId } : {})
    },
    layout: {
      icon: { code: SURVEY_ACTIVITY_LOGO },
      header: { title: neutralizeBb(`Результат опроса: ${input.surveyTitle}`).slice(0, 255) },
      body: {
        logo: { code: SURVEY_ACTIVITY_LOGO, action: { type: 'redirect', uri: dealPath } },
        blocks
      },
      // ⚠️ Футер ВЕРНУЛСЯ вместе со страницей результата (#18, вторая половина). До неё кнопка
      // стояла бы здесь мёртвой: виджет `responseId` не читал, открывать было нечего, а кнопка,
      // ведущая в пустой экран, хуже её отсутствия. Теперь она открывает тот же виджет карточки
      // сделки, а `responseId` в `actionParams` говорит ему показать ответ целиком.
      //
      // ⚠️ Условие ровно одно — НЕПУСТОЙ `responseId`: без него кнопке нечего открывать. Две ошибки,
      // которые тут были: гейт стоял на МАРКЕРЕ (он про дедуп дела, а не про показ ответа — появись
      // путь, где маркер считается позже, кнопка исчезла бы молча) и пропускал пустую строку
      // (кнопка была бы, `readText('')` вернул бы `undefined`, и виджет предложил бы выписать НОВОЕ
      // приглашение клиенту, который только что ответил).
      //
      // ⚠️ Сводка в теле дела от кнопки не зависит — ради неё менеджер сюда и смотрит.
      ...(input.responseId
        ? {
            footer: {
              buttons: {
                openResult: {
                  title: 'Открыть результат',
                  type: 'secondary',
                  action: {
                    type: 'openRestApp',
                    // Имена параметров собирает ОБЩИЙ хелпер — их же читает виджет (см. JSDoc
                    // `resultActionParams`): разойдясь, кнопка молча открыла бы экран выписки нового
                    // приглашения клиенту, который только что ответил.
                    actionParams: resultActionParams({ responseId: input.responseId, dealId: input.dealId })
                  }
                }
              }
            }
          }
        : {})
    }
  }
}

/**
 * `crm.activity.configurable.add` → id созданной активности. Вызывать токеном портала ТОЛЬКО
 * после верификации события/фрейма (анти-форджери, как `dealGet`/`entityGet`). Метод `*.add`
 * возвращает id новой активности; B24 REST местами сериализует id СТРОКОЙ — коэрсим в `number`,
 * чтобы тип не лгал (`callMethod` только кастит `result`, без runtime-проверки).
 */
export async function activityConfigurableAdd(client: PortalClient, params: ConfigurableActivityParams): Promise<number> {
  return Number(await callMethod<number | string>(client, 'crm.activity.configurable.add', params))
}

/**
 * Найти НАШИ дела по маркеру. 🔎 Проверено на живом портале: `crm.activity.list` фильтрует по
 * `ORIGIN_ID`/`ORIGINATOR_ID` точным совпадением, чужой ключ даёт ноль записей, а `COMPLETED`
 * читается тем же запросом — то есть «есть ли открытое дело по этому переходу» стоит ОДИН вызов.
 *
 * ⚠️ Фильтруем по ОБОИМ полям, а не по одному `ORIGIN_ID`: `ORIGINATOR_ID` отделяет наши дела от
 * чужих, если чей-то интегратор случайно возьмёт ту же форму ключа. Портал общий, и рассчитывать,
 * что кроме нас туда никто не пишет, нельзя.
 *
 * ⚠️ И по СДЕЛКЕ, когда она известна. `ORIGIN_ID` — обычное записываемое поле `crm.activity`, а его
 * форма угадывается: ключ опроса виден в ссылке нашего же дела, а ID записей истории стадий монотонны
 * и читаются `crm.stagehistory.list`. Без привязки к сделке сотрудник, чей CSAT измеряют, мог бы
 * заранее наплодить ОТКРЫТЫХ дел с нашим маркером «на пару шагов вперёд» — правило увидело бы `open`
 * и промолчало, то есть датчик по его сделкам выключился бы незаметно. Привязка к владельцу делает
 * такую подделку заметной: подложить дело нужно в ту самую сделку.
 */
export async function activityListByMarker(
  client: PortalClient,
  marker: InviteMarker,
  /** Сделка, в таймлайне которой ищем. `undefined` — поиск только по маркеру (пути без сделки). */
  dealId?: number
): Promise<MarkedActivity[]> {
  const rows = await callMethod<Array<{ ID?: number | string; COMPLETED?: string }>>(
    client,
    'crm.activity.list',
    {
      filter: {
        ORIGINATOR_ID: marker.originatorId,
        ORIGIN_ID: marker.originId,
        ...(dealId !== undefined ? { OWNER_TYPE_ID: DEAL_OWNER_TYPE_ID, OWNER_ID: dealId } : {})
      },
      select: ['ID', 'COMPLETED']
    }
  )
  return (rows ?? [])
    .map((r) => ({ id: Number(r.ID), completed: r.COMPLETED === 'Y' }))
    // Строка без читаемого id бесполезна как «дело, которое можно открыть», но ВАЖНА как факт
    // «приглашение уже есть»: выбрасывать её значило бы пригласить второй раз. Поэтому id=0, а не drop.
    .map((a) => (Number.isFinite(a.id) ? a : { id: 0, completed: a.completed }))
}

/**
 * Убедиться, что маркер на созданном деле стоит, и дописать его, если нет.
 *
 * ⚠️ Это не перестраховка, а закрытая ставка. `crm.activity.configurable.add` недоступен вебхуку
 * (`ERROR_WRONG_CONTEXT`; его нет даже в списке методов портала), поэтому принимает ли он поля
 * маркера — на сегодня непроверяемо. Не примет молча — поиск не найдёт дело, и следующее событие
 * грозди создаст второе, то есть дефект вернётся именно тем путём, который мы чиним. Один лишний
 * `crm.activity.get` на СОЗДАНИЕ (не на каждое событие) снимает вопрос, а лог показывает, какая
 * ветка сработала: первый же живой прогон даёт ответ раз и навсегда.
 */
export async function ensureActivityMarker(
  client: PortalClient,
  activityId: number,
  marker: InviteMarker
): Promise<MarkerFix> {
  // ⚠️ Сверяем ОБА поля, потому что поиск фильтрует по обоим (`activityListByMarker`). Сверка одного
  // `ORIGIN_ID` давала бы худший из исходов: `configurable.add` принял `originId`, но не `originatorId`
  // → сверка рапортует `already`, чинить нечего, а поиск по двум полям дело не находит → второе
  // приглашение на тот же переход. То есть страховка отчиталась об успехе ровно там, где провалилась.
  const marked = async (): Promise<boolean> => {
    const row = await callMethod<{ ORIGINATOR_ID?: string; ORIGIN_ID?: string } | null>(
      client, 'crm.activity.get', { id: activityId }
    )
    return row?.ORIGINATOR_ID === marker.originatorId && row?.ORIGIN_ID === marker.originId
  }
  if (await marked()) return 'already'
  await callMethod(client, 'crm.activity.update', {
    id: activityId,
    fields: { ORIGINATOR_ID: marker.originatorId, ORIGIN_ID: marker.originId }
  })
  // ⚠️ ПЕРЕЧИТЫВАЕМ, а не верим вызову. `crm.activity.update` возвращает успех и тогда, когда поле
  // для этого типа дела не поддерживается: раньше мы объявляли `repaired` по факту вызова, и провал
  // защиты был бы неотличим в логе от её работы.
  return (await marked()) ? 'repaired' : 'failed'
}

/**
 * Открытые дела-приглашения ЭТОЙ сделки по ЭТОМУ опросу.
 *
 * **Потребителей ДВА, и вопросы у них разные:**
 *  - закрытие при получении ответа ([#177](https://github.com/bx-shef/polls/issues/177)) — ему нужны
 *    `ids`, дела надо открыть и закрыть;
 *  - дедуп ручного пути ([#176](https://github.com/bx-shef/polls/issues/176)) — ему нужен `found`,
 *    вопрос ровно один: «приглашение по этой сделке уже висит?».
 *
 * ⚠️ **`found` и `ids.length` — РАЗНОЕ, и это несущее.** Строка без читаемого `ID` бесполезна как
 * «дело, которое можно открыть», но важна как факт «приглашение уже есть»: выбросив её, дедуп
 * пригласил бы второй раз. Тот же разбор — у `activityListByMarker`, и здесь он повторён намеренно,
 * потому что первая редакция этой функции писалась под закрытие и молча роняла такие строки.
 *
 * ⚠️ Ищем не по полному маркеру, а по владельцу и коду приложения: ключа перехода на этом пути нет
 * (клиент отвечает по ссылке; на ручном пути перехода нет вовсе — менеджер нажал кнопку). Опрос
 * отфильтровываем разбором `ORIGIN_ID` уже у себя — так закрытие по одному опросу не заденет дело по
 * другому, висящее на той же сделке.
 */
export async function findOpenInviteActivities(
  client: PortalClient,
  dealId: number,
  surveyKey: string
): Promise<{ found: number; ids: number[] }> {
  const rows = await callMethod<Array<{ ID?: number | string; ORIGIN_ID?: string }>>(
    client,
    'crm.activity.list',
    {
      filter: {
        ORIGINATOR_ID: INVITE_ORIGINATOR,
        OWNER_TYPE_ID: DEAL_OWNER_TYPE_ID,
        OWNER_ID: dealId,
        COMPLETED: 'N'
      },
      select: ['ID', 'ORIGIN_ID'],
      // ⚠️ Явный кап, а не молчаливая первая страница портала. Дел на сделке единицы; сотня означает
      // поломку (маркер не проставился — `markerFix: failed` — и каждый переход плодит новое дело).
      // Разница в том, что явный предел видно в коде, а обрезку страницы — только на проде.
      start: 0
    }
  )
  const ours = (rows ?? []).filter((r) => markerMatchesSurvey(r.ORIGIN_ID, surveyKey))
  return {
    found: ours.length,
    ids: ours.map((r) => Number(r.ID)).filter((id) => Number.isFinite(id) && id > 0)
  }
}

/**
 * Те же дела, но только их id — для закрытия (#177). Тонкая обёртка, чтобы вызывающий не тащил
 * ненужную ему пару: закрытию нечего делать со строкой без читаемого id.
 */
export async function openInviteActivities(
  client: PortalClient,
  dealId: number,
  surveyKey: string
): Promise<number[]> {
  return (await findOpenInviteActivities(client, dealId, surveyKey)).ids
}

/**
 * Закрыть дело (`COMPLETED: Y`) — «клиент ответил, звать больше незачем».
 *
 * ⚠️ Закрытие делает достижимыми две нижние строки правила «уже приглашали?»: до него дело висело
 * открытым вечно, а значит на любой повторный переход правило отвечало «ждём клиента» — даже когда
 * клиент давно ответил.
 */
export async function completeActivity(client: PortalClient, activityId: number): Promise<void> {
  await callMethod(client, 'crm.activity.update', { id: activityId, fields: { COMPLETED: 'Y' } })
}
