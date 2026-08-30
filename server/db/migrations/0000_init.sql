CREATE TABLE "inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "link_index" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"item_id" bigint NOT NULL,
	"survey_code" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portal_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dedup_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" text NOT NULL,
	"domain" text NOT NULL,
	"public_host" text,
	"access_token" text,
	"refresh_token" text,
	"token_expires_at" timestamp with time zone,
	"scopes" text[],
	"license" text,
	"status" text DEFAULT 'active' NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stage_cache" (
	"portal_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" bigint NOT NULL,
	"last_stage" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stage_cache_portal_id_entity_type_entity_id_pk" PRIMARY KEY("portal_id","entity_type","entity_id")
);
--> statement-breakpoint
ALTER TABLE "inbox" ADD CONSTRAINT "inbox_portal_id_portals_id_fk" FOREIGN KEY ("portal_id") REFERENCES "public"."portals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_index" ADD CONSTRAINT "link_index_portal_id_portals_id_fk" FOREIGN KEY ("portal_id") REFERENCES "public"."portals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_portal_id_portals_id_fk" FOREIGN KEY ("portal_id") REFERENCES "public"."portals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_cache" ADD CONSTRAINT "stage_cache_portal_id_portals_id_fk" FOREIGN KEY ("portal_id") REFERENCES "public"."portals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_status_received_idx" ON "inbox" USING btree ("status","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "link_index_token_hash_key" ON "link_index" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "link_index_expires_idx" ON "link_index" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_portal_dedup_key" ON "outbox" USING btree ("portal_id","dedup_key");--> statement-breakpoint
CREATE INDEX "outbox_status_created_idx" ON "outbox" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "portals_member_id_key" ON "portals" USING btree ("member_id");