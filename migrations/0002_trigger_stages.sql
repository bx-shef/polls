-- 0002: денормализация invitationPolicy.triggerStages в индексируемую колонку (#22).
-- Заполняется PgStore.publish из политики версии; binding-хендлер ONCRMDEALUPDATE (#17)
-- запрашивает «какие опросы триггерит стадия X» через GIN (@>), без full-scan compiled_schema.
-- Уровень — survey_version (политика заморожена с версией, #21); запрос идёт по ТЕКУЩЕЙ версии.
-- Безопасна на greenfield-деплое: существующие строки получают default '{}' (живых политик
-- до #22 не было, backfill не нужен). Идемпотентна: add column / create index ... if not exists.

alter table survey_version
  add column if not exists trigger_stages text[] not null default '{}';

create index if not exists idx_survey_version_trigger_stages
  on survey_version using gin (trigger_stages);
