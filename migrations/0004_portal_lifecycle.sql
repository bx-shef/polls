-- Миграция 0004: устойчивость OAuth-lifecycle портала (docs/project-map.md §2).
-- Аддитивна и идемпотентна (add column if not exists / create table if not exists) —
-- безопасна на живой БД (portal — обычно одна строка).

-- updated_at: когда последний раз получили СВЕЖУЮ пару токенов (install/refresh).
-- Основа keep-alive: refresh_token Bitrix24 живёт ~180 дней; простаивающий портал
-- (никто не проходит опрос) без вызовов теряет токен на 180-й день. Крон рефрешит
-- порталы у истечения по этому столбцу (improvement-plan §2.4).
alter table portal add column if not exists updated_at timestamptz not null default now();

-- application_token: доставляется в первом ONAPPINSTALL, write-once. Единственный способ
-- аутентифицировать ONAPPUNINSTALL (у события нет иных данных). Захват при установке и
-- обработка uninstall — improvement-plan §2.1 (следующий шаг). Столбец готовим заранее.
alter table portal add column if not exists application_token text;

-- Тумбстоун: защита от out-of-order install/uninstall (B24 не гарантирует порядок событий
-- и может ретраить). deleted_ts — unix-СЕКУНДЫ (top-level `ts` вебхука). Устаревший install
-- после uninstall не воскрешает удалённый портал; TTL-подметание — improvement-plan §2.2.
create table if not exists portal_tombstone (
  member_id  text primary key,
  deleted_ts bigint not null
);
