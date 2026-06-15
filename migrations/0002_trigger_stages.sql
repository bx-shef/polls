-- 0002: денормализация invitationPolicy.triggerStages в индексируемую колонку (#22).
-- Заполняется PgStore.publish из политики версии; binding-хендлер ONCRMDEALUPDATE (#17)
-- запрашивает «какие опросы триггерит стадия X» через GIN (@>), без full-scan compiled_schema.
-- Уровень — survey_version (политика заморожена с версией, #21); запрос идёт по ТЕКУЩЕЙ версии.

alter table survey_version
  add column if not exists trigger_stages text[] not null default '{}';

create index if not exists idx_survey_version_trigger_stages
  on survey_version using gin (trigger_stages);
