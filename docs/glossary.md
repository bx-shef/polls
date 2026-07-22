# Глоссарий

> Термины проекта для быстрого онбординга свежей сессии. Подробности — в указанных
> модулях/доках.

- **Контур A** — публичный анонимный сбор ответов: экраны Интро/Опрос/Спасибо +
  эндпоинты `/api/session`, `/api/submit`. Без Bitrix24-авторизации. См. `brief.md` §9-A.
- **Контур B** — закрытый дашборд результатов внутри Bitrix24 (аналитика, scopes
  `crm`/`user_brief`). См. `brief.md` §9-B.
- **`SurveyFill`** — framework-agnostic «мозг» прохождения опроса (контур A): навигация/
  deep-link, валидация шага, single/multi + exclusive, «Другое», persist-снимок,
  маппинг в `Submission`. Без DOM/Vue — Vue-композабл оборачивает реактивностью.
  `src/client/survey-fill.ts` (#24).
- **Версия-снимок (CompiledVersion)** — иммутабельный результат `compile()` черновика:
  опубликованная версия не перезаписывается, ответ пинится на номер версии при отправке.
  См. `domain/compile.ts`.
- **`question_key` / `option_key`** — стабильные ключи вопроса/варианта; якоря
  сопоставимости между версиями (по ним `diffVersions` сопоставляет ряды). Инвариант ядра.
- **Invitation** — одноразовое приглашение (single-use токен) к прохождению: при submit
  токен → снимок `CrmContext`. Replay→409, unknown→403, чужой пин→409. См. `api/invitation.ts`.
- **CrmContext** — снимок контекста из CRM Bitrix24 (сделка/услуга/клиент/направление),
  привязанный к ответу через приглашение. Маппинг — `docs/bitrix24-integration.md`.
- **`exclusive`** — взаимоисключающий вариант в `multi`-вопросе («ничего/нет»): его
  выбор снимает прочие, выбор обычного — снимает исключающий. См. `brief.md` §4.
- **Подавление малых N** — на чувствительных срезах агрегаты не отдаются, если выборка
  меньше порога (`ANONYMITY_THRESHOLD`/`meetsAnonymity`) — защита анонимности.
  Ответственность слоя чтения/PgStore, не «сырых» агрегатов.
- **`portalId`** — tenant-ключ: 1 портал = 1 инстанс = своя БД (решение №7).
  PgStore tenant-scoped по нему; кросс-портальной мультитенантности нет. Численно = `member_id`
  портала Bitrix24.
- **`member_id`** — стабильный идентификатор портала Bitrix24 (= `portalId`). В handshake фрейма
  берётся НЕ из сырого POST, а из авторитетной проверки токена (анти-cross-tenant, #47).
- **Handshake фрейма** — обмен параметров `BX24.getAuth` (`DOMAIN`/`member_id`/`AUTH_ID`),
  которые портал отдаёт iframe-приложению, на подписанную сессию дашборда (cookie `polls_portal`).
  Ядро — `src/bitrix24/frame.ts` (#47): SSRF-allowlist домена + сверка `member_id`.
- **install-poisoning** — атака: владелец реального портала A подделывает установку с ЧУЖИМ
  `member_id` + своими валидными токенами → отравил бы tenant-ключ жертвы (с §2.1 uninstall — вплоть
  до удаления данных жертвы). `member_id` в install-POST — клиент-контролируемое поле.
- **member_id-binding** — защита от install-poisoning (§2.3): при установке рефрешим присланный
  `refresh_token`, OAuth-сервер Bitrix возвращает **authoritative** `member_id` гранта, который обязан
  совпасть с заявленным (иначе 403). Ядро — `src/bitrix24/verify-install.ts` (`verifyInstallMember`).
- **Keyset-пагинация** — курсорная пагинация по стабильному ключу (`listResponsesPage`),
  без OFFSET. Helpers — `store/cursor.ts`.
- **`triggerStages`** — денормализованные стадии/статусы-триггеры опроса (под binding сущности
  `entityType`); индексируются GIN, читаются `IStore.surveysTriggeredBy` (#22).
- **`entityType`** — тип сущности-датчика Bitrix24 в `invitationPolicy` (deal/lead/spa/contact/
  company/task; дефолт deal). Для `spa` обязателен `spaEntityTypeId` (id смарт-процесса) — инвариант схемы.
  `task` (задача) — особый случай: нет стадии воронки, автотриггер по стадии неприменим, только ручной
  запуск из карточки задачи (`TASK_VIEW_SIDEBAR`, `task.ts`).
- **`CrmContext.dealStageId`** — обобщённый «триггер-ключ» снимка контекста: для сделки `STAGE_ID`,
  для лида `STATUS_ID`, для смарт-процесса `stageId`; у контакта/компании не заполняется (ручной
  запуск из виджета). Имя историческое («deal»); `surveysTriggeredBy` матчит его по строке.
  Переименование в `entityStageId` — отдельный рефактор (#next, после стабилизации всех сущностей).
- **`invitationPolicy`** — политика приглашений (датчик: `entityType`/`spaEntityTypeId`/`triggerStages`/
  `channelOrder`), вшитая в схему/версию на уровне version-frozen (решение #21). См. `decisions.md`.

---
*Последнее ревью: 2026-07-22.*
