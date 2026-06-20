# Интеграция с Bitrix24 — связка ядра с CRM

> Фаза связки: как сущности CRM Bitrix24 ложатся в `CrmContext` ядра
> (`src/domain/schema.ts`) и как это проверено **вживую** на портале. Ядро
> OAuth/шифрования — в `src/bitrix24/` (см. [#3](https://github.com/bx-shef/polls/issues/3)).

`CrmContext` — это снимок CRM-контекста, который ядро привязывает к завершённой
анкете (`ResponseRecord.context`) и по которому потом режет аналитику на 4 уровнях
(клиент · направление · услуга · KPI ответственного). Чтобы инвайт-флоу (#3) и
read-API строились на реальных данных, маппинг «поля сделки → `CrmContext`»
зафиксирован и проверен живым smoke-тестом (`scripts/b24-smoke.ts`).

## Маппинг: Bitrix24 REST → `CrmContext`

Источник — сделка (`crm.deal.get` / `crm.deal.list`) + её товарные позиции
(`crm.deal.productrows.get`):

| `CrmContext`        | Поле Bitrix24                         | Уровень аналитики |
| ------------------- | ------------------------------------- | ----------------- |
| `dealId`            | `crm.deal` → `ID`                     | —                 |
| `dealCategoryId`    | `CATEGORY_ID`                         | направление       |
| `dealStageId`       | `STAGE_ID`                            | (срез по стадии)  |
| `companyId`         | `COMPANY_ID`                          | клиент            |
| `contactId`         | `CONTACT_ID`                          | (адресат #3)      |
| `responsibleId`     | `ASSIGNED_BY_ID`                      | KPI сотрудника    |
| `dealAmount`        | `OPPORTUNITY`                         | (вес/денежный)    |
| `companyName`       | `crm.company.get` → `TITLE`           | клиент (подпись среза) |
| `dealCategoryName`  | `crm.category.get` → `NAME` (устаревший алиас — `crm.dealcategory.get`) | направление (подпись среза) |
| `responsibleName`   | `user.get` → `NAME`+`LAST_NAME`       | ответственный (подпись среза) |
| `products[].productId` / `productName` | `crm.deal.productrows.get` → `PRODUCT_ID` / `PRODUCT_NAME` | услуга |

**Денормализованные имена** (`companyName`/`dealCategoryName`/`responsibleName`/`productName`) —
снимок подписи на момент закрытия сделки, чтобы срезы дашборда (контур B) читались без обращения
к CRM-справочникам. Опциональны: при отсутствии срез падает на внутренний ID (вида `#11`).
`responsibleName` — PII (ФИО), под PII-редакцию #31. Боевой адаптер резолвит имена одним батчем
доп-запросов к CRM при снятии контекста.

## Нюансы, выявленные живым прогоном

1. **Числа приходят строками.** REST отдаёт `ID`/`OPPORTUNITY`/`*_ID` как строки
   (`"5994"`, `"66938"`). Боевой адаптер обязан коэрцить в `number` до валидации —
   иначе zod-схема (`z.number()`) отвергнет запись. В smoke это хелпер `num()`.
2. **Формат `STAGE_ID` зависит от воронки.** У общей воронки (`CATEGORY_ID=0`)
   стадия «голая» (`EXECUTING`); у кастомных — с префиксом `C{categoryId}:STAGE`.
   Схема `dealStageId: z.string()` покрывает оба, но срезы/маппинг стадий должны
   это учитывать (нормализация на стороне отчёта, а не схемы).
3. **`CrmContext` — снимок на закрытии.** Семантически контекст снимается при
   переходе сделки в `WON` (событие `ONCRMDEALUPDATE`). Smoke берёт сделку в любой
   стадии — этого хватает для проверки *формы* маппинга, но инвайт-флоу (#3) должен
   слушать именно закрытие.
4. **Канал приглашения не гарантирован.** У контакта может быть `PHONE`, но не быть
   `EMAIL` (наблюдалось вживую). Инвайт-флоу (#3) **не может предполагать email** —
   нужен выбор канала (email/SMS) или fallback, иначе часть клиентов недостижима.
5. **Все поля контекста опциональны.** B2C-сделка без компании, сделка без товаров —
   валидны; маппинг устойчив (живой батч: 10/10 сделок прошли схему).

## Smoke-тест (`scripts/b24-smoke.ts`)

Только ЧТЕНИЕ; проверяет весь путь связки на живом портале через **inbound-вебхук**:

```bash
# минимально (только батч — секции C/D, 10 последних сделок):
B24_WEBHOOK_URL='https://<portal>/rest/<id>/<token>/' pnpm exec tsx scripts/b24-smoke.ts

# опционально: + целевая сделка (секции A/B) и свой размер батча
B24_WEBHOOK_URL='…' B24_DEAL_ID=<id> B24_DEAL_LIMIT=20 pnpm exec tsx scripts/b24-smoke.ts
```

Секции: **A** целевая сделка → `CrmContext` + zod · **B** резолвинг
компании/контакта и наличие каналов (email/phone) · **C** батч последних N сделок
(робастность маппинга) · **D** агрегация ядра (`byCompany`/`byCategory`/`byProduct`/
`kpiByResponsible`) на реальном контексте — NPS-ответы **синтетические и
детерминированные** (живых ответов на портале ещё нет).

**Приватность.** Домен/токен портала — только в env (`.env` в `.gitignore`),
в репозиторий/CI не попадают (портал ротируется ежемесячно). ПДн контактов
(имя/телефон/email) **не печатаются** — только факт наличия канала (boolean).
Согласуется с privacy-правилом ядра (живые данные портала не уходят в облако/CI).

## Invitation-flow (#3): снимок CRM-контекста в ответе

`submit` исторически писал `context: {}`. Приглашение со снимком закрывает пробел.
Поток:

1. **Сделка → триггер-стадия.** Binding-endpoint ловит `ONCRMDEALUPDATE`, маппит
   сделку → `CrmContext` (таблица выше), создаёт приглашение: снимок контекста +
   пин `surveyKey/versionNo` + одноразовый токен.
2. **Доставка.** Binding-слой выбирает канал и шлёт ссылку с токеном.
3. **Сабмит.** `POST /api/submit` с полем `invitation` резолвит токен → снимок
   становится `ResponseRecord.context`.

**Решения (конфиг — на стороне опроса):**

- **Триггер задаёт опрос.** `invitationPolicy.triggerStages: string[]` — `stage_id`,
  переход в которые запускает опрос (а не хардкод WON); стадии портал-специфичны
  (нюанс №2 выше). Хелпер `shouldInvite(stageId, policy)`.
- **Порядок каналов задаёт опрос.** `invitationPolicy.channelOrder` (`email→sms`
  либо `sms→email`) — первый доступный у контакта канал побеждает (`chooseChannel`).
  Нет канала → приглашение не шлётся, а **пропуск пишется в таймлайн сделки**
  (`crm.timeline.comment`) **или смарт-элемента** (timeline соответствующего СПА),
  чтобы оператор видел причину.

**Сделано (ядро-рантайм, `src/`):**

- Тип `Invitation` (`domain/schema.ts`): токен + снимок `CrmContext` + пин опроса/
  версии + статус/сроки. **ПДн адресата не храним** — канал резолвит binding-слой.
- `InvitationStore` / `MemoryInvitationStore` (`api/invitation.ts`) по образцу
  nonce: `create`→токен, `peek` (только живые), `consume` (single-use, сверка пина).
- Проводка `POST /api/submit` (`api/handlers.ts`): токен сверяется/расходуется **после**
  422 (чтобы ошибка ответов не сжигала неповторимое приглашение). Коды: повтор → 409
  (single-use; полноценная идемпотентность `addResponse` на уровне стора — отдельно, #4),
  чужой пин (surveyKey/versionNo) → 409 БЕЗ расхода токена, неизвестный/протухший → 403.
  Без токена — `context: {}` (back-compat).
- Чистые `shouldInvite` / `chooseChannel` + тип `InvitationPolicy`
  (`domain/invitation.ts`) — кодируют решения выше, тестируемы изолированно.

**Остаётся (storage + binding) — [#17](https://github.com/bx-shef/polls/issues/17); идемпотентность/общий стор — [#4](https://github.com/bx-shef/polls/issues/4):**

- Сделано (#17): `invitationPolicy` вшит в `surveyDraft`/`compiledVersion` (compiled_schema JSONB);
  денормализация `triggerStages` (миграция `0002`, GIN) + `IStore.surveysTriggeredBy` (#22) — сделано.
  Остаётся: сам binding-endpoint `ONCRMDEALUPDATE`.
- `MemoryInvitationStore` → таблица в `PgStore` для мульти-инстанса (как nonce, #4).
- Endpoint `ONCRMDEALUPDATE`: детект триггер-стадии (категория-aware:
  `crm.dealcategory.stage.list` для кастомных воронок, `crm.status` для общей
  `CATEGORY_ID=0`), дедуп по `dealId`, отправка ссылки по `chooseChannel`, запись
  пропуска в таймлайн. Поверх `src/bitrix24/`.

## Handshake app-фрейма дашборда (#47) — аутентификация контура B

Дашборд (`/d/:key`) живёт в iframe портала Bitrix24. При загрузке фрейма Bitrix24 отдаёт
параметры авторизации (`BX24.getAuth`): `DOMAIN`, `member_id`, `AUTH_ID` (access-token),
`AUTH_EXPIRES`, и т.д. Приложение обменивает их на свою подписанную сессию (cookie `polls_portal`,
см. `src/api/session.ts`), которой гейтится эндпоинт дашборда (`requirePortalSession`).

Ядро-рантайм handshake — `src/bitrix24/frame.ts` (под тестами `test/frame.test.ts`, без живого портала):

1. `parseFrameAuth(raw)` — zod-парс **недоверенного** POST (параметры приходят на публичный
   эндпоинт, их может подделать кто угодно).
2. `isAllowedPortalDomain(DOMAIN)` — **SSRF-гард**: `DOMAIN` управляем злоумышленником, а мы по нему
   делаем исходящий REST-вызов. Allowlist — облачные `*.bitrix24.<tld>` (вкл. двойные TLD `.com.br`);
   блок `xn--` (анти-гомоглиф), отказ при `slash`/порте/завершающей точке; self-hosted переопределяет RegExp.
3. `verifyFrameAuth(frame, { authenticate })` — **анти-cross-tenant**: `member_id` НЕ берётся из сырого
   POST (иначе со своим валидным токеном можно выписать сессию на чужой tenant). `authenticate`
   (инжектируемый, боевой — живая проверка `AUTH_ID` через REST/OAuth) возвращает АВТОРИТЕТНЫЙ
   `member_id`; он сверяется с заявленным — расхождение → отказ. `portalId` = авторитетный `member_id`.
4. `mintPortalSession(portal, secret, ttl)` — подписывает сессию (`signSession`).

**Остаётся (слой связки #49):** эндпоинт `POST /api/b24/session` (читает body фрейма → `parseFrameAuth`
→ `verifyFrameAuth` с боевым `authenticate` → `setCookie` `polls_portal`) + участие страницы дашборда
(BX24 JS SDK в iframe). Требования к боевой реализации:
- `authenticate` — ЛЁГКИЙ REST-вызов с `AUTH_ID` (НЕ OAuth-refresh: он ротирует токен → race при
  параллельных загрузках фрейма), авторитетно возвращающий `member_id`; `AUTH_ID` передавать в
  теле/заголовке, НЕ в query (иначе токен утечёт в access-логи прокси и `x-request-id`).
- Cookie `polls_portal`: `HttpOnly`+`Secure`+`SameSite=None`+**`Partitioned`** (CHIPS) — браузеры
  блокируют непартиционированные third-party cookies в iframe; fallback — токен через `postMessage`
  (не URL). Проверить на живом портале.
- tenant-фильтрация стора по `portalId` — там же (#49).

## Остаётся (слой связки)

- **[#17](https://github.com/bx-shef/polls/issues/17)** — инвайт-флоу: ядро-рантайм
  готов; `invitationPolicy` вшита, `triggerStages` индексированы (`surveysTriggeredBy`, #22).
  Остаётся binding-endpoint `ONCRMDEALUPDATE` — он обязан нормализовать `stageId` из вебхука
  к тому же формату, что в `triggerStages` (category-aware), иначе GIN-матч не сработает и опрос
  молча не триггернётся; и валидировать `STAGE_ID` через zod. (#3 про OAuth-токены — закрыт.)
- **[#4](https://github.com/bx-shef/polls/issues/4)** — идемпотентность `addResponse`
  по invitation (чтобы повтор перехода/сабмита не плодил записи).

---
*Последнее ревью: 2026-06-20.*
