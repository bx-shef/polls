-- Схема хранения сервиса опросов (PostgreSQL).
-- Соответствует docs/data-model.md. Применяется автоматически контейнером
-- postgres из docker-compose (mount в /docker-entrypoint-initdb.d).

-- ── Портал (локальное приложение: обычно одна строка) ──
create table if not exists portal (
  id           bigserial primary key,
  member_id    text unique not null,
  domain       text not null,
  tokens       jsonb not null,
  installed_at timestamptz not null default now()
);

-- ── Авторы (зеркало пользователей Bitrix24) ──
create table if not exists app_user (
  id          bigserial primary key,
  portal_id   bigint not null references portal (id),
  b24_user_id bigint not null,
  role        text not null default 'author' check (role in ('author', 'admin', 'viewer')),
  unique (portal_id, b24_user_id)
);

-- ── Группа опросов ──
create table if not exists survey_group (
  id             bigserial primary key,
  portal_id      bigint not null references portal (id),
  owner_user_id  bigint references app_user (id),
  title          text not null,
  visibility     text not null default 'private' check (visibility in ('private', 'department', 'portal')),
  visibility_ref bigint,
  created_at     timestamptz not null default now()
);

-- ── Опрос (логический; стабильный survey_key) ──
create table if not exists survey (
  id                 bigserial primary key,
  group_id           bigint not null references survey_group (id),
  survey_key         text not null,
  title              text not null,
  lang               text not null default 'ru',
  status             text not null default 'draft',
  current_version_id bigint,
  created_at         timestamptz not null default now(),
  unique (group_id, survey_key)
);

-- ── Версия опроса (иммутабельна после публикации) ──
create table if not exists survey_version (
  id              bigserial primary key,
  survey_id       bigint not null references survey (id),
  version_no      int not null,
  status          text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  compiled_schema jsonb,
  published_at    timestamptz,
  unique (survey_id, version_no)
);

-- ── Вопрос (per version; стабильный question_key) ──
create table if not exists survey_question (
  id           bigserial primary key,
  version_id   bigint not null references survey_version (id),
  question_key text not null,
  block        text,
  position     int not null,
  type         text not null check (type in ('single', 'multi', 'text')),
  metric       text,                      -- nps|csat|ces|scale|choice|text
  required     boolean not null default true,
  columns      int default 1,
  text         text not null,
  unique (version_id, question_key)
);

-- ── Вариант (per question; стабильный option_key) ──
create table if not exists survey_option (
  id           bigserial primary key,
  question_id  bigint not null references survey_question (id),
  option_key   text not null,
  position     int not null,
  label        text not null,
  score        numeric,
  is_other     boolean not null default false,
  is_exclusive boolean not null default false,
  unique (question_id, option_key)
);

-- ── Приглашение: пин версии + снимок CRM-контекста ──
create table if not exists invitation (
  id                bigserial primary key,
  portal_id         bigint not null references portal (id),
  survey_id         bigint not null references survey (id),
  survey_version_id bigint not null references survey_version (id),
  token             text unique not null,
  channel           text,
  status            text not null default 'sent', -- sent|opened|completed|expired
  deal_id           bigint,
  deal_category_id  bigint,
  deal_stage_id     text,
  company_id        bigint,
  contact_id        bigint,
  responsible_id    bigint,
  deal_title        text,
  deal_amount       numeric,
  context           jsonb,
  sent_at           timestamptz not null default now(),
  completed_at      timestamptz
);

-- ── Ответ (одна заполненная анкета) ──
create table if not exists response (
  id                bigserial primary key,
  portal_id         bigint references portal (id),
  invitation_id     bigint references invitation (id),
  survey_id         bigint not null references survey (id),
  survey_version_id bigint not null references survey_version (id),
  version_no        int not null,
  lang              text,
  deal_id           bigint,
  deal_category_id  bigint,
  company_id        bigint,
  contact_id        bigint,
  responsible_id    bigint,
  nps_value         int,
  csat_value        numeric,
  sentiment         numeric,
  status            text not null default 'raw' check (status in ('raw', 'analyzed')),
  submitted_at      timestamptz not null default now()
);
create index if not exists idx_response_survey on response (survey_id);
create index if not exists idx_response_company on response (company_id);
create index if not exists idx_response_category on response (deal_category_id);
create index if not exists idx_response_responsible on response (responsible_id);
create index if not exists idx_response_submitted on response (submitted_at);

-- ── Ответ на вопрос ──
create table if not exists response_answer (
  id           bigserial primary key,
  response_id  bigint not null references response (id) on delete cascade,
  question_key text not null,
  metric       text,
  value_choice text[],
  value_number numeric,
  value_text   text check (value_text is null or char_length(value_text) <= 4000),
  position     int
);
create index if not exists idx_answer_question on response_answer (question_key);

-- ── Товары/услуги сделки (для агрегации «по услуге») ──
create table if not exists response_product (
  response_id  bigint not null references response (id) on delete cascade,
  product_id   bigint not null,
  product_name text,
  service_tag  text,
  primary key (response_id, product_id)
);
create index if not exists idx_response_product on response_product (product_id);

-- ── AI-инсайты (отдельно от сырья; перезапускаемо) ──
create table if not exists answer_insight (
  id           bigserial primary key,
  response_id  bigint not null references response (id) on delete cascade,
  question_key text,
  theme        text,
  sentiment    numeric,
  intent       text,
  summary      text,
  model        text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_insight_theme on answer_insight (theme);
