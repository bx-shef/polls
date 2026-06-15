# Модель данных и аналитика

> Как вносить вопросы, как организованы пользователи / группы / опросы, как это
> хранить, что делать при изменении вопросов и как считать итог на четырёх
> уровнях. Дополняет [`brief.md`](./brief.md) (поток, бэкенд, сценарии §13) и
> [`design.md`](./design.md) (UI).

---

## Оглавление

1. [Модель развёртывания: локальное приложение](#1-модель-развёртывания-локальное-приложение)
2. [Иерархия: пользователь → группа → опрос → версия](#2-иерархия-пользователь--группа--опрос--версия)
3. [Внесение вопросов (авторинг)](#3-внесение-вопросов-авторинг)
4. [Версионирование: что делать, если вопросы меняются](#4-версионирование-что-делать-если-вопросы-меняются)
5. [Хранение: схема PostgreSQL](#5-хранение-схема-postgresql)
6. [Привязка к CRM: снимок контекста](#6-привязка-к-crm-снимок-контекста)
7. [Уровни агрегации (4 уровня)](#7-уровни-агрегации-4-уровня)
8. [🧠 Илон: что анализировать и как](#8--илон-что-анализировать-и-как)
9. [Поток данных end-to-end](#9-поток-данных-end-to-end)
10. [Требования к продакшену (по фазам)](#10-требования-к-продакшену-по-фазам)

---

## 1. Модель развёртывания: локальное приложение

**Один портал = один инстанс = одна БД.** Клиент (его Bitrix24) разворачивает
приложение на своём сервере; другой клиент — у себя. Инстансы не связаны, данные
не покидают сервер клиента.

- Приложение ставится как **локальное** (Application/Installation URL, scopes из
  §13 брифа). При установке сохраняем `member_id` портала, домен и OAuth-токены
  (для вызовов REST: чтение сделки, постинг в ленту и т. д.).
- Мультитенантность — **внутри одного портала**: разные пользователи, группы,
  опросы. Кросс-портальной нет (это не SaaS). `member_id` всё же храним на
  корневых записях — на случай, если один бинарь обслужит несколько порталов.
- Хранилище — **PostgreSQL** рядом в `docker-compose` (решение №2 брифа).

```
Клиент A: [Bitrix24 A] ── local app ── [Nuxt + PostgreSQL] (сервер A)
Клиент B: [Bitrix24 B] ── local app ── [Nuxt + PostgreSQL] (сервер B)
            (полностью независимые установки)
```

---

## 2. Иерархия: пользователь → группа → опрос → версия

Запрошенная структура «разные пользователи — разные группы опросов — разные
опросы» ложится в дерево владения:

```
portal
 └─ app_user (автор)                       зеркало пользователя Bitrix24
     └─ survey_group (группа опросов)       папка; видимость: личная/отдел/портал
         └─ survey (опрос)                  логический, стабильный survey_key
             └─ survey_version (версия)     иммутабельна после публикации
                 └─ survey_question         стабильный question_key
                     └─ survey_option       стабильный option_key
```

- **`app_user`** — автор/владелец (Bitrix24 user). PII не дублируем — имя тянем
  из REST по `b24_user_id`.
- **`survey_group`** — папка опросов с **видимостью** (`private` — только автор,
  `department` — отдел, `portal` — весь портал). Так разные пользователи ведут
  разные наборы опросов и при необходимости делятся ими.
- **`survey`** — логический опрос (стабильный `survey_key`), у которого есть
  черновик и опубликованные версии.

---

## 3. Внесение вопросов (авторинг)

Вопросы вносятся в **визуальном конструкторе** (страница приложения на b24ui:
`B24Form` + список вопросов; типы из §4 брифа — `single`/`multi`/`text`, флаги
`other`/`exclusive`, `columns`, `required`).

**Источник истины — нормализованные таблицы** (`survey_question` / `survey_option`):
их удобно редактировать, валидировать и по ним строить агрегаты. При **публикации**
версия «компилируется» в иммутабельный `compiled_schema` (JSONB — это `CompiledVersion`
движка: `surveyKey`/`title`/`lang`/`versionNo`/`questions`/`compiledAt`; UX-поля
`intro`/`thanks`/`blocks` — контракт фронта, хранятся отдельно) — его отдаёт фронт опроса.

```
Конструктор → survey_question/option (черновик)
   │  publish()
   ▼
survey_version.compiled_schema (JSONB, заморожен)  →  фронт опроса (кэш)
```

Каждому вопросу автор назначает **метрику** (`metric`): `nps` (0–10), `csat`
(шкала), `ces`, `scale`, `choice`, `text`. Метрика — якорь сопоставимости и
аналитики (см. §4, §8), а не просто тип контрола.

---

## 4. Версионирование: что делать, если вопросы меняются

**Главное правило: опубликованная версия иммутабельна.** Любая правка создаёт
**новую версию** (черновик → публикация). Ответы навсегда привязаны к той версии,
по которой их собрали, — историю не переписываем.

**Стабильные ключи.** `question_key` и `option_key` сохраняются, когда вопрос/вариант
«тот же по смыслу». Это позволяет сшивать аналитику между версиями (один временной
ряд NPS, даже если формулировку поправили).

**Классы изменений — решают, что с сопоставимостью:**

| Изменение | Что делаем | Сопоставимость рядов |
|---|---|---|
| Правка текста / опечатка (смысл тот же) | тот же `question_key`, новая версия | **полная** — один ряд |
| Добавили / убрали / переименовали вариант | `option_key` стабилен для сохранённых; новый вариант — новый key | **частичная** — по key, пропуски как gap |
| Сменили смысл / шкалу / метрику вопроса | **новый `question_key`** | **намеренный разрыв** — новый ряд |
| Убрали вопрос | в новой версии его нет; старые ответы остаются | ряд завершается |
| Добавили вопрос | новый `question_key` с этой версии | ряд начинается |

**Ключевой приём для опросов по сделке — пин версии на момент отправки.** Когда
робот по закрытию сделки создаёт приглашение (`invitation`), в нём фиксируется
`survey_version_id` **текущей опубликованной версии**. Клиент всегда отвечает на
запиненную версию. Публикация v2 во время сбора **не трогает** уже отправленные
приглашения — миграции «на лету» не нужны вовсе.

**Аналитика поверх версий** агрегирует по `(metric, question_key)`, а не по тексту
и не по номеру версии. Где ключ намеренно сменили — график показывает границу
сопоставимости.

---

## 5. Хранение: схема PostgreSQL

DDL-эскиз (иллюстративный; имена/индексы — под доработку). Двойное представление:
нормализованные таблицы авторинга + замороженный `compiled_schema` для отдачи.

```sql
-- ── Портал (локальное приложение: обычно одна строка) ──
create table portal (
  id           bigserial primary key,
  member_id    text unique not null,        -- идентификатор Bitrix24
  domain       text not null,
  tokens       jsonb not null,              -- OAuth (шифровать на уровне приложения)
  installed_at timestamptz default now()
);

-- ── Авторы (зеркало пользователей Bitrix24) ──
create table app_user (
  id          bigserial primary key,
  portal_id   bigint references portal(id),
  b24_user_id bigint not null,
  role        text not null default 'author',   -- author | admin | viewer
  unique (portal_id, b24_user_id)
);

-- ── Группа опросов ──
create table survey_group (
  id             bigserial primary key,
  portal_id      bigint references portal(id),
  owner_user_id  bigint references app_user(id),
  title          text not null,
  visibility     text not null default 'private',  -- private | department | portal
  visibility_ref bigint,                            -- id отдела при department
  created_at     timestamptz default now()
);

-- ── Опрос (логический; стабильный survey_key) ──
create table survey (
  id                 bigserial primary key,
  group_id           bigint references survey_group(id),
  survey_key         text not null,            -- стабилен между версиями
  title              text not null,
  lang               text not null default 'ru',   -- один опрос = один язык
  status             text not null default 'draft', -- draft|active|paused|archived
  current_version_id bigint,                   -- опубликованная версия по умолчанию
  created_at         timestamptz default now(),
  unique (group_id, survey_key)
);

-- ── Версия опроса (иммутабельна после публикации) ──
create table survey_version (
  id              bigserial primary key,
  survey_id       bigint references survey(id),
  version_no      int not null,
  status          text not null default 'draft',  -- draft | published | archived
  compiled_schema jsonb,                          -- замороженная схема для фронта
  published_at    timestamptz,
  unique (survey_id, version_no)
);

-- ── Вопрос (per version; стабильный question_key) ──
create table survey_question (
  id           bigserial primary key,
  version_id   bigint references survey_version(id),
  question_key text not null,               -- стабилен между версиями
  block        text,
  position     int not null,
  type         text not null,               -- single | multi | text
  metric       text,                        -- nps|csat|ces|scale|choice|text
  required     boolean not null default true,
  columns      int default 1,
  text         text not null,
  unique (version_id, question_key)
);

-- ── Вариант (per question; стабильный option_key) ──
create table survey_option (
  id           bigserial primary key,
  question_id  bigint references survey_question(id),
  option_key   text not null,
  position     int not null,
  label        text not null,
  score        numeric,                     -- для шкальных (напр. 0..10)
  is_other     boolean default false,
  is_exclusive boolean default false,
  unique (question_id, option_key)
);

-- ── Приглашение: пин версии + снимок контекста сделки ──
create table invitation (
  id                bigserial primary key,
  portal_id         bigint references portal(id),
  survey_id         bigint references survey(id),
  survey_version_id bigint references survey_version(id),  -- ПИН версии
  token             text unique not null,
  channel           text,                  -- email | sms | imol | link
  status            text not null default 'sent', -- sent|opened|completed|expired
  -- снимок CRM на момент закрытия сделки:
  deal_id           bigint,
  deal_category_id  bigint,                -- направление
  deal_stage_id     text,
  company_id        bigint,                -- клиент
  contact_id        bigint,
  responsible_id    bigint,                -- ответственный (KPI)
  deal_title        text,
  deal_amount       numeric,
  context           jsonb,                 -- полный снимок при необходимости
  sent_at           timestamptz default now(),
  completed_at      timestamptz
);

-- ── Ответ (одна заполненная анкета) ──
create table response (
  id                bigserial primary key,
  portal_id         bigint references portal(id),
  invitation_id     bigint references invitation(id),
  survey_id         bigint references survey(id),
  survey_version_id bigint references survey_version(id),
  version_no        int not null,
  lang              text,
  -- денормализованный снимок контекста (быстрые rollup без обращения к CRM):
  deal_id           bigint,
  deal_category_id  bigint,
  company_id        bigint,
  contact_id        bigint,
  responsible_id    bigint,
  -- кэш метрик:
  nps_value         int,
  csat_value        numeric,
  sentiment         numeric,
  status            text not null default 'raw',  -- raw | analyzed
  submitted_at      timestamptz default now()
);
create index on response (survey_id);
create index on response (company_id);
create index on response (deal_category_id);
create index on response (responsible_id);
create index on response (submitted_at);

-- ── Ответ на вопрос ──
create table response_answer (
  id           bigserial primary key,
  response_id  bigint references response(id),
  question_key text not null,
  metric       text,
  value_choice text[],                     -- option_key[] (single/multi)
  value_number numeric,                    -- nps/csat/scale (через option.score)
  value_text   text,                       -- verbatim, включая «Другое»
  position     int
);
create index on response_answer (question_key);

-- ── Товары/услуги сделки (для агрегации «по услуге») ──
create table response_product (
  response_id  bigint references response(id),
  product_id   bigint,
  product_name text,
  service_tag  text,                       -- нормализованная услуга (опц.)
  primary key (response_id, product_id)
);
create index on response_product (product_id);

-- ── AI-инсайты (отдельно от сырых ответов; перезапускаемо) ──
create table answer_insight (
  id           bigserial primary key,
  response_id  bigint references response(id),
  question_key text,
  theme        text,                       -- тема / драйвер
  sentiment    numeric,                    -- -1..1
  intent       text,                       -- recovery|upsell|praise|bug|none
  summary      text,
  model        text,
  created_at   timestamptz default now()
);
create index on answer_insight (theme);
```

**Почему так:**
- `compiled_schema` (JSONB) — иммутабельный контракт для фронта; нормализованные
  таблицы — для авторинга и аналитики. Один источник истины (таблицы), JSONB
  выводится при публикации.
- `response_answer` хранит **ключи и числа**, а не текст вариантов → агрегация
  переживает смену формулировок.
- `answer_insight` отделён от сырья → AI можно перезапустить (новая модель) без
  потери исходных ответов.
- DDL выше — эскиз структуры; **`not null`, FK, индексы, CHECK-ограничения и
  лимиты длины** заданы в рабочей миграции `migrations/0001_init.sql`.

---

## 6. Привязка к CRM: снимок контекста

Чтобы считать итог «по услуге / клиенту / направлению», на каждом ответе нужен
**снимок CRM-контекста**, снятый в момент закрытия сделки (а не live-join: CRM
потом меняется, а нам нужна историческая правда и быстрые отчёты).

**Когда снимаем:** робот по стадии «Сделка успешна» (§13) дёргает наш handler →
читаем сделку и кладём контекст в `invitation`; при сабмите копируем в `response`
и `response_product`.

| Что снимаем | Источник (REST) | Поле |
|---|---|---|
| Направление (воронка) | `crm.deal.get` → `CATEGORY_ID` | `deal_category_id` |
| Клиент | `crm.deal.get` → `COMPANY_ID` | `company_id` |
| Контакт | `crm.deal.get` → `CONTACT_ID` | `contact_id` |
| Ответственный (KPI) | `crm.deal.get` → `ASSIGNED_BY_ID` | `responsible_id` |
| Стадия / сумма / название | `crm.deal.get` → `STAGE_ID`/`OPPORTUNITY`/`TITLE` | `deal_*` |
| Товары/услуги | `crm.deal.productrows.get` → `PRODUCT_ID`/`PRODUCT_NAME` | `response_product` |
| Список направлений (справочник) | `crm.dealcategory.list` / `crm.category.list` | для фильтров |

> Методы сверены по REST-докам Bitrix24. `crm.deal.*` и `crm.deal.productrows.get`
> рабочие; современные аналоги — `crm.item.get` / `crm.item.productrow.list`
> (entityTypeId = 2 для сделок).

---

## 7. Уровни агрегации (4 уровня)

Все четыре — это `GROUP BY` по `response`/`response_answer`, отфильтрованные по
снятому контексту и сгруппированные по `(metric, question_key)`. (NPS = % промоутеров
[9–10] − % детракторов [0–6]; CSAT — средний/доля топ-бокса.)

**Уровень 1 — по одному опросу:**
```sql
select count(*) as responses,
       round(100.0*avg((ra.value_number>=9)::int)
           - 100.0*avg((ra.value_number<=6)::int), 1) as nps
from response r
join response_answer ra on ra.response_id = r.id and ra.metric = 'nps'
where r.survey_id = :survey_id;          -- по всем версиям опроса
```

**Уровень 2 — по опросам на услугу/товар:**
```sql
select rp.product_id, rp.product_name,
       count(distinct r.id) as responses,
       round(avg(ra.value_number), 2) as csat
from response r
join response_product rp on rp.response_id = r.id
join response_answer ra on ra.response_id = r.id and ra.metric = 'csat'
where rp.product_id = :product_id        -- или rp.service_tag = :service
group by rp.product_id, rp.product_name;
```

**Уровень 3 — по сделкам от одного клиента (здоровье клиента в динамике):**
```sql
select date_trunc('month', r.submitted_at) as month,
       count(*) as responses,
       round(avg(ra.value_number), 2) as csat
from response r
join response_answer ra on ra.response_id = r.id and ra.metric = 'csat'
where r.company_id = :company_id         -- все сделки клиента
group by 1 order by 1;
```

> Эскизы иллюстративны; рабочая реализация — `PgStore.aggregateNps/Csat/Distribution`
> (источник чисел — `response_answer.value_number/value_choice`). Колонки
> `response.nps_value`/`csat_value` — резерв под BI/AI-кэш: `addResponse` их
> НЕ заполняет.

**Уровень 4 — по всем сделкам направления (+ KPI ответственных):**
```sql
select r.responsible_id,
       count(*) as responses,
       round(100.0*avg((ra.value_number>=9)::int)
           - 100.0*avg((ra.value_number<=6)::int), 1) as nps
from response r
join response_answer ra on ra.response_id = r.id and ra.metric = 'nps'
where r.deal_category_id = :category_id  -- направление/воронка
group by r.responsible_id
having count(*) >= 5                      -- порог значимости/анонимности
order by nps desc;
```

**Распределение варианта (версионно-безопасно, по `question_key`):**
```sql
select opt, count(*) 
from response r
join response_answer ra on ra.response_id = r.id
cross join lateral unnest(ra.value_choice) as opt
where r.survey_id = :survey_id and ra.question_key = :qkey
group by opt order by 2 desc;
```

Один снимок контекста на ответе закрывает все четыре среза — без джойнов в CRM и
без N запросов к REST на отчёт.

---

## 8. 🧠 Илон: что анализировать и как

*Снова на связи. Голос — мой, дисциплина — его.*

Вы спрашиваете «что анализировать». Неправильный вопрос. Сначала — **что вы
решаете этим числом**. Метрика, под которой нет действия, — это тщеславие, удалите её.

**Что анализировать (лестница сверху вниз):**

1. **Одна северная звезда на опрос.** NPS *или* CSAT *или* CES — выберите ОДНУ.
   Остальные метрики — диагностика, не витрина. Десять KPI = ноль KPI.
2. **Почему (драйверы).** Темы и тональность из verbatim («Другое» + текст) — это
   **80% ценности**. Драйвер-анализ: какие темы коррелируют с детракторами. Число
   говорит «плохо», драйвер — «почему именно».
3. **Тренд.** Динамика по `question_key` (версионно-безопасно). Уровень бесполезен
   без производной — падает или растёт?
4. **Сегменты-выбросы.** Сравнение по услуге / направлению / ответственному —
   ищите **аномалии**, а не средние. Среднее по больнице лечит никого.
5. **Действие.** На каждый ответ — следующий шаг: детрактор → recovery, промоутер
   → отзыв/реферал, баг-тема → задача. Это и есть продукт (Сценарий A, §13).

**Как анализировать (метод, без него цифры врут):**

- **Агрегируй по `(metric, question_key)`,** не по тексту и не по версии →
  переживает смену формулировок (§4).
- **Два слоя.** Детерминированный (SQL: NPS/CSAT/распределения) + AI
  (verbatim → тема/тональность/намерение) в `answer_insight`. AI-слой —
  перезапускаемый и воспроизводимый, не «магия в реальном времени».
- **Статистическая гигиена.** Порог `N ≥ 5` перед любым срезом (особенно KPI
  сотрудников и мелкие сегменты) → защищает анонимность и режет шум. Показывай
  размер выборки и доверительный интервал; помечай границы сопоставимости версий.
- **Контролируй микс.** Сравнивая ответственных/направления — **нормируй на микс
  услуг и размер сделки**. Иначе KPI накажет того, кто продаёт сложный продукт.
  Контролируй переменные — или метрика лжёт.
- **Замыкай петлю.** Вывод анализа обязан породить задачу/уведомление в Bitrix24,
  иначе это красивый дашборд, который никто не открывает.
- **Приватность по типу.** Клиентские опросы привязаны к сделке (это нормально —
  B2B-обратная связь). Опросы сотрудников — **анонимны**: только агрегаты + порог,
  никогда индивидуально.

**Северная метрика продукта (не опроса):** доля ответов, **приведших к действию**
(recovery/upsell/исправленный баг). Если она низкая — вы собираете данные, а не
управляете. Чините это первым.

---

## 9. Поток данных end-to-end

```
[Авторинг] конструктор → survey_question/option → publish → survey_version.compiled_schema
                                                                     │
[Триггер]  сделка «Успешна» → робот (§13) → handler:                 │
              crm.deal.get + crm.deal.productrows.get  ──► invitation (пин версии + контекст)
                                                                     │
[Сбор]     клиент открывает ссылку → фронт берёт compiled_schema → отвечает
                                                                     │
[Запись]   submit → response (+ снимок контекста) + response_answer + response_product
                                                                     │
[Анализ]   детерминированные метрики (SQL) + AI → answer_insight; кэш в response
                                                                     │
[Витрина]  дашборд (§9-B брифа): 4 уровня агрегации + KPI + темы
                                                                     │
[Действие] детрактор → задача recovery; промоутер → запрос отзыва (замыкание петли)
```

---

## 10. Требования к продакшену (по фазам)

Фаза 1 (ядро) закрывает доменную логику, валидацию и ограничения схемы.
Нижеследующее обязательно к реализации в фазах деплоя/связки — трекать
отдельными ISSUE:

| Требование | Фаза | Статус |
|---|---|---|
| Шифрование OAuth-токенов (`portal.tokens`, AES-256-GCM) + refresh-flow + startup-guard ключа — `src/bitrix24` | Фаза 5 | ✅ |
| OAuth install/callback-эндпоинт + живой обмен с порталом Bitrix24 | Связка | 🔶 [#3](https://github.com/bx-shef/polls/issues/3) |
| Серверный анти-абьюз в ядре (`src/api`): nonce TTL → 409, honeypot → 400, rate-limit → 429, server-set `submittedAt` | Фаза 4 | ✅ |
| Анти-абьюз остаток: идемпотентность по invitation (с #3), общий стор nonce/лимитов (мульти-инстанс) | Деплой | 🔶 [#4](https://github.com/bx-shef/polls/issues/4) |
| Наблюдаемость (ядро `src/obs`): структурный логгер + редакция секретов, `GET /api/health` (200/503, кэш), error-tracking unhandled, `x-request-id` | Фаза 6 | ✅ |
| Наблюдаемость (деплой): адаптеры `Logger`→Pino / `onFatal`→Sentry, живой `/health` за reverse-proxy, метрики/OTel-трейсы | Деплой | 🔶 [#5](https://github.com/bx-shef/polls/issues/5) |
| Раннер миграций: `node-pg-migrate` поверх `migrations/*.sql` (`pnpm migrate up`); те же `.sql` применяют pglite-тесты; initdb убран. Осталось: живой прогон на Postgres | Деплой | 🔶 [#6](https://github.com/bx-shef/polls/issues/6) |
| Async-контракт хранилища (`IStore`) для перехода MemoryStore→PgStore | Фаза 1 | ✅ |
| Порог анонимности `N`: `ANONYMITY_THRESHOLD` + `meetsAnonymity`; принудительное подавление чувствительных срезов — в `PgStore.aggregateNps/Csat/Distribution`. PII-erasure (#4) должен чистить `response.context` (JSONB), денормализованные колонки (`contact_id`, …) и `response_product.product_name` | Фаза 1–3 | ✅ |
| `PgStore` (CRUD + tenant-изоляция `portalId`) — на pglite-тестах | Фаза 2 | ✅ |
| Read-API: keyset-пагинация, SQL-агрегация + принудительное подавление малых N, денормализация, транзакции, идемпотентный ensure | Фаза 3 | ✅ |
| Read-API остаток: идемпотентность `addResponse` (с #4), PII-редакция на HTTP-слое, SQL-вариант `npsTrend` | Деплой | 🔶 [#10](https://github.com/bx-shef/polls/issues/10) |
| CHECK-ограничения и лимиты длины в схеме БД | Фаза 1 | ✅ |
| Границы payload в zod (`.max`) | Фаза 1 | ✅ |

---

*Спецификация — [`brief.md`](./brief.md) · Дизайн — [`design.md`](./design.md) ·
Шаблон схемы — [`reference/survey-schema.template.json`](./reference/survey-schema.template.json).*

*Последнее ревью: 2026-06-15.*
