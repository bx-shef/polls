-- 0003: durable-идемпотентность ответа по токену приглашения (#3/#4, мульти-инстанс).
-- Проблема: MemoryInvitationStore single-use живёт В ПАМЯТИ одного инстанса — при
-- нескольких инстансах за reverse-proxy один и тот же токен мог записаться дважды
-- (каждый инстанс не знает о расходе на соседнем). Решение: партиционная по порталу
-- уникальность invitation_token — БД ловит дубль на ЛЮБОМ инстансе (общий стор #4
-- ещё впереди, но запись в Postgres уже общая). PgStore.addResponse кладёт токен и
-- делает INSERT ... ON CONFLICT DO NOTHING → повтор = тихий no-op (идемпотентно).
-- Безопасна на greenfield: колонка nullable, существующие строки получают NULL
-- (частичный индекс их не трогает — публичные ответы по ссылке без приглашения).
-- Идемпотентна: add column / create index ... if not exists.

alter table response
  add column if not exists invitation_token text check (invitation_token is null or char_length(invitation_token) <= 256);

create unique index if not exists uq_response_invitation_token
  on response (portal_id, invitation_token) where invitation_token is not null;
