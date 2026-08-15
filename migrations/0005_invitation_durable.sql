-- 0005: приглашения переезжают из памяти в БД (#4).
--
-- ⚠️ ТОЛЬКО ДОБАВЛЕНИЕ И ОСЛАБЛЕНИЕ. На boot журнала миграций нет: `applyMigrations` проигрывает
-- ВЕСЬ каталог при каждом старте контейнера. Удаление или переименование колонки, на которую
-- смотрит индекс из 0001, уронило бы следующий старт — а с watchtower это crash-loop на живом проде.
-- Поэтому здесь нет ни DROP COLUMN, ни RENAME, ни смены типов, а всё создаётся через IF NOT EXISTS.
-- Побочно это же даёт симметрию отката: watchtower откатит образ, схему — нет, и старый образ обязан
-- работать с новой схемой. Он работает: все добавленные колонки nullable, старые не тронуты.
--
-- ⚠️ Таблица `invitation` из 0001 существует с первой миграции, но рантайм её НИКОГДА не использовал
-- (писателя не было ни одного). Пересоздать её нельзя: на неё смотрит FK `response.invitation_id`.
-- Поэтому дополняем.
--
-- ⚠️ Осознанный компромисс: `survey_id`/`survey_version_id` ослабляются до nullable и остаются
-- НЕИСПОЛЬЗОВАННЫМИ, а опрос и версия хранятся денормализованно (`survey_key`/`version_no`). Порт
-- `InvitationStore` пинит приглашение парой (surveyKey, versionNo) и сверяет при расходе именно её;
-- резолвить суррогатные id пришлось бы запросом на КАЖДОЕ создание — то есть лишний round-trip на
-- вебхучном пути события сделки, — ради ссылочной целостности, которую мы ни разу не читаем.

alter table invitation
  -- Токен хранится ХЕШЕМ: база — это то, что мы защищаем, и из дампа не должны доставаться рабочие
  -- ссылки. Открытый токен существует ровно один раз, в ответе `create`, и больше нигде.
  add column if not exists token_hash text,
  add column if not exists survey_key text,
  add column if not exists version_no integer,
  -- Срок жизни ссылки (`invitationPolicy.linkTtlSeconds`, 5 мин — 5 дней). Ради него переезд и
  -- затевался: в памяти он не переживал перезапуск, а перезапуск идёт на каждом мерже.
  add column if not exists expires_at timestamptz,
  -- Отметка расхода. Одноразовость держится на ней и на условии `used_at is null` в UPDATE.
  add column if not exists used_at timestamptz;

-- Ослабление: 0001 требовал суррогатные id и открытый токен, которых у нового пути нет.
alter table invitation alter column survey_id drop not null;
alter table invitation alter column survey_version_id drop not null;
alter table invitation alter column token drop not null;

-- Уникальность хеша в пределах портала. Частичный — старые строки (если бы были) без хеша не мешают.
create unique index if not exists uq_invitation_token_hash
  on invitation (portal_id, token_hash) where token_hash is not null;

-- Под чистку по сроку и под `peek`/`consume`: оба ходят по живым приглашениям.
create index if not exists idx_invitation_live
  on invitation (portal_id, expires_at) where used_at is null;
