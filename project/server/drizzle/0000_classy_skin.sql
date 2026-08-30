CREATE TYPE "public"."date_granularity" AS ENUM('day', 'month', 'year', 'decade');--> statement-breakpoint
CREATE TYPE "public"."entity_type" AS ENUM('user', 'thread', 'comment', 'tag', 'terms', 'person', 'place', 'media', 'story', 'relationship', 'source');--> statement-breakpoint
CREATE TYPE "public"."proposal_kind" AS ENUM('create', 'edit');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TABLE "entity" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"type" "entity_type" NOT NULL,
	"version" integer,
	"original_language" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "entity_published_version_positive" CHECK ("entity"."version" IS NULL OR "entity"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "entity_version" (
	"entity_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" uuid NOT NULL,
	"redaction_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "entity_version_entity_id_version_pk" PRIMARY KEY("entity_id","version"),
	CONSTRAINT "entity_version_positive" CHECK ("entity_version"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "person" (
	"entity_id" uuid NOT NULL,
	"version" integer,
	"proposal_id" uuid,
	"born" daterange,
	"born_granularity" date_granularity,
	"died" daterange,
	"died_granularity" date_granularity,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "person_born_granularity_paired" CHECK (("person"."born" IS NULL) = ("person"."born_granularity" IS NULL)),
	CONSTRAINT "person_died_granularity_paired" CHECK (("person"."died" IS NULL) = ("person"."died_granularity" IS NULL)),
	CONSTRAINT "person_died_after_born" CHECK ("person"."born" IS NULL OR "person"."died" IS NULL OR upper("person"."born") <= lower("person"."died")),
	CONSTRAINT "person_version_or_proposal" CHECK (version IS NOT NULL OR proposal_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "person_content" (
	"entity_id" uuid NOT NULL,
	"version" integer,
	"proposal_id" uuid,
	"language" text NOT NULL,
	"name" text NOT NULL,
	"abstract" text,
	"description" text,
	"search_config" "regconfig" NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector("person_content"."search_config", coalesce("person_content"."name", '')), 'A') || setweight(to_tsvector("person_content"."search_config", coalesce("person_content"."abstract", '')), 'B')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "person_content_version_or_proposal" CHECK (version IS NOT NULL OR proposal_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "proposal" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"entity_id" uuid NOT NULL,
	"kind" "proposal_kind" NOT NULL,
	"status" "proposal_status" DEFAULT 'pending' NOT NULL,
	"based_on_version" integer,
	"rejection_reason" text,
	"moderator_id" uuid,
	"terms_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "proposal_rejection_documented" CHECK (("proposal"."status" <> 'rejected') OR ("proposal"."rejection_reason" IS NOT NULL AND "proposal"."moderator_id" IS NOT NULL)),
	CONSTRAINT "proposal_based_on_matches_kind" CHECK (("proposal"."kind" = 'create') = ("proposal"."based_on_version" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "user" (
	"entity_id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"alias" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "entity" ADD CONSTRAINT "entity_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity" ADD CONSTRAINT "entity_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_version" ADD CONSTRAINT "entity_version_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_version" ADD CONSTRAINT "entity_version_published_by_entity_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_version" ADD CONSTRAINT "entity_version_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_version" ADD CONSTRAINT "entity_version_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_proposal_id_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_content" ADD CONSTRAINT "person_content_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_content" ADD CONSTRAINT "person_content_proposal_id_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_content" ADD CONSTRAINT "person_content_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_content" ADD CONSTRAINT "person_content_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_moderator_id_entity_id_fk" FOREIGN KEY ("moderator_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entity_type_idx" ON "entity" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "person_published_unique" ON "person" USING btree ("entity_id","version") WHERE "person"."proposal_id" IS NULL;--> statement-breakpoint
CREATE INDEX "person_entity_version_idx" ON "person" USING btree ("entity_id","version");--> statement-breakpoint
CREATE INDEX "person_proposal_idx" ON "person" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "person_born_idx" ON "person" USING gist ("born");--> statement-breakpoint
CREATE INDEX "person_died_idx" ON "person" USING gist ("died");--> statement-breakpoint
CREATE UNIQUE INDEX "person_content_published_unique" ON "person_content" USING btree ("entity_id","version","language") WHERE "person_content"."proposal_id" IS NULL;--> statement-breakpoint
CREATE INDEX "person_content_entity_version_idx" ON "person_content" USING btree ("entity_id","version");--> statement-breakpoint
CREATE INDEX "person_content_proposal_idx" ON "person_content" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "person_content_search_idx" ON "person_content" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "proposal_entity_idx" ON "proposal" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "proposal_status_idx" ON "proposal" USING btree ("status");