CREATE TABLE "survey_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_id" uuid NOT NULL,
	"code" text NOT NULL,
	"version" integer NOT NULL,
	"schema" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Через умолчание и снятие: `ADD COLUMN ... NOT NULL` без него падает на непустой
-- таблице. Сегодня ссылок ещё нет, но миграция не должна зависеть от того, накатили
-- ли её вовремя. Итоговое состояние — NOT NULL без умолчания, как в схеме.
ALTER TABLE "link_index" ADD COLUMN "survey_version" integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE "link_index" ALTER COLUMN "survey_version" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "survey_templates" ADD CONSTRAINT "survey_templates_portal_id_portals_id_fk" FOREIGN KEY ("portal_id") REFERENCES "public"."portals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "survey_templates_portal_code_version_key" ON "survey_templates" USING btree ("portal_id","code","version");