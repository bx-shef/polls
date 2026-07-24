import type { PortalClient } from './client'
import { callMethod } from './client'

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
 * Нейтрализация BB-кода в тексте, попадающем в таймлайн Bitrix (защита от инъекции `[url=…]`/меток/
 * кнопок): скобки `[`/`]` → полноширинные `［`/`]`. Порт live-verified паттерна соседа `ai-price-import`
 * (`chatNotify.neutralizeBb`). Наш `surveyTitle` авторит админ портала (тот же домен доверия), но это
 * ПЕРВЫЙ пишущий-в-таймлайн путь polls — нейтрализуем defense-in-depth и для паритета. Длину строки не
 * меняет (замена 1:1), поэтому применяется ДО `.slice`. */
export function neutralizeBb(text: string): string {
  return String(text ?? '').replace(/\[/g, '［').replace(/\]/g, '］')
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
}

/** Параметры `crm.activity.configurable.add` (по REST-контракту Bitrix24 + live-verified сосед). */
export interface ConfigurableActivityParams {
  ownerTypeId: number
  ownerId: number
  fields: {
    typeId: string
    completed: 'Y' | 'N'
    responsibleId?: number
  }
  layout: {
    icon: { code: string }
    header: { title: string }
    body: {
      logo: { code: string; action: { type: string; uri: string } }
      blocks: Record<string, unknown>
    }
    footer: { buttons: Record<string, unknown> }
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
      ...(input.responsibleId != null ? { responsibleId: input.responsibleId } : {})
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
              type: 'openRestApp',
              actionParams: { surveyKey: input.surveyKey, token: input.token, dealId: input.dealId }
            }
          }
        }
      }
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
