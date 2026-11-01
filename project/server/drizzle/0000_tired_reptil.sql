CREATE TYPE "public"."date_granularity" AS ENUM('day', 'month', 'year', 'decade');--> statement-breakpoint
CREATE TYPE "public"."entity_type" AS ENUM('user', 'thread', 'comment', 'tag', 'terms', 'person', 'place', 'media', 'story', 'relationship', 'source');--> statement-breakpoint
CREATE TYPE "public"."media_file_role" AS ENUM('original', 'web', 'thumb');--> statement-breakpoint
CREATE TYPE "public"."moderation_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TABLE "asset" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"width" integer,
	"height" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "asset_storageKey_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "citation" (
	"entity_id" uuid NOT NULL,
	"version" integer,
	"proposal_id" uuid,
	"source_entity_id" uuid NOT NULL,
	"locator" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "citation_version_or_proposal" CHECK (version IS NOT NULL OR proposal_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "comment" (
	"entity_id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"body" text NOT NULL,
	"status" "moderation_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "entity_tag" (
	"entity_id" uuid NOT NULL,
	"version" integer,
	"proposal_id" uuid,
	"tag_entity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "entity_tag_version_or_proposal" CHECK (version IS NOT NULL OR proposal_id IS NOT NULL)
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
CREATE TABLE "link" (
	"entity_id" uuid NOT NULL,
	"version" integer,
	"proposal_id" uuid,
	"target_entity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "link_version_or_proposal" CHECK (version IS NOT NULL OR proposal_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "media" (
	"entity_id" uuid NOT NULL,
	"version" integer,
	"proposal_id" uuid,
	"captured" daterange,
	"captured_granularity" date_granularity,
	"latitude" double precision,
	"longitude" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "media_captured_granularity_paired" CHECK (("media"."captured" IS NULL) = ("media"."captured_granularity" IS NULL)),
	CONSTRAINT "media_point_paired" CHECK (("media"."latitude" IS NULL) = ("media"."longitude" IS NULL)),
	CONSTRAINT "media_version_or_proposal" CHECK (version IS NOT NULL OR proposal_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "media_content" (
	"entity_id" uuid NOT NULL,
	"version" integer,
	"proposal_id" uuid,
	"language" text NOT NULL,
	"name" text NOT NULL,
	"abstract" text,
	"description" text,
	"caption" text,
	"search_config" "regconfig" NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector("media_content"."search_config", coalesce("media_content"."name", '')), 'A') || setweight(to_tsvector("media_content"."search_config", coalesce("media_content"."abstract", '')), 'B') || setweight(to_tsvector("media_content"."search_config", coalesce("media_content"."caption", '')), 'C')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "media_content_version_or_proposal" CHECK (version IS NOT NULL OR proposal_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "media_file" (
	"entity_id" uuid NOT NULL,
	"version" integer,
	"proposal_id" uuid,
	"asset_id" uuid NOT NULL,
	"role" "media_file_role" NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "media_file_version_or_proposal" CHECK (version IS NOT NULL OR proposal_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "person" (
	"entity_id" uuid NOT NULL,
	"version" integer,
	"proposal_id" uuid,
	"born" daterange,
	"born_granularity" date_granularity,
	"deceased" boolean DEFAULT false NOT NULL,
	"died" daterange,
	"died_granularity" date_granularity,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "person_born_granularity_paired" CHECK (("person"."born" IS NULL) = ("person"."born_granularity" IS NULL)),
	CONSTRAINT "person_died_granularity_paired" CHECK (("person"."died" IS NULL) = ("person"."died_granularity" IS NULL)),
	CONSTRAINT "person_died_implies_deceased" CHECK ("person"."died" IS NULL OR "person"."deceased"),
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
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector("person_content"."search_config", coalesce("person_content"."name", '')), 'A') || setweight(to_tsvector("person_content"."search_config", coalesce("person_content"."abstract", '')), 'B') || setweight(to_tsvector("person_content"."search_config", coalesce("person_content"."description", '')), 'C')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "person_content_version_or_proposal" CHECK (version IS NOT NULL OR proposal_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "place" (
	"entity_id" uuid NOT NULL,
	"version" integer,
	"proposal_id" uuid,
	"latitude" double precision,
	"longitude" double precision,
	"area" jsonb,
	"min_latitude" double precision,
	"max_latitude" double precision,
	"min_longitude" double precision,
	"max_longitude" double precision,
	"valid_from" daterange,
	"valid_from_granularity" date_granularity,
	"valid_until" daterange,
	"valid_until_granularity" date_granularity,
	"validity_extent" daterange GENERATED ALWAYS AS (daterange(lower("place"."valid_from"), upper("place"."valid_until"))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "place_valid_from_granularity_paired" CHECK (("place"."valid_from" IS NULL) = ("place"."valid_from_granularity" IS NULL)),
	CONSTRAINT "place_valid_until_granularity_paired" CHECK (("place"."valid_until" IS NULL) = ("place"."valid_until_granularity" IS NULL)),
	CONSTRAINT "place_valid_until_after_from" CHECK ("place"."valid_from" IS NULL OR "place"."valid_until" IS NULL OR upper("place"."valid_from") <= lower("place"."valid_until")),
	CONSTRAINT "place_point_paired" CHECK (("place"."latitude" IS NULL) = ("place"."longitude" IS NULL)),
	CONSTRAINT "place_version_or_proposal" CHECK (version IS NOT NULL OR proposal_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "place_content" (
	"entity_id" uuid NOT NULL,
	"version" integer,
	"proposal_id" uuid,
	"language" text NOT NULL,
	"name" text NOT NULL,
	"abstract" text,
	"description" text,
	"search_config" "regconfig" NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector("place_content"."search_config", coalesce("place_content"."name", '')), 'A') || setweight(to_tsvector("place_content"."search_config", coalesce("place_content"."abstract", '')), 'B') || setweight(to_tsvector("place_content"."search_config", coalesce("place_content"."description", '')), 'C')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "place_content_version_or_proposal" CHECK (version IS NOT NULL OR proposal_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "proposal" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"entity_id" uuid NOT NULL,
	"status" "proposal_status" DEFAULT 'pending' NOT NULL,
	"based_on_version" integer,
	"rejection_reason" text,
	"moderator_id" uuid,
	"terms_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "proposal_rejection_documented" CHECK (("proposal"."status" <> 'rejected') OR ("proposal"."rejection_reason" IS NOT NULL AND "proposal"."moderator_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "relationship" (
	"entity_id" uuid NOT NULL,
	"version" integer,
	"proposal_id" uuid,
	"kind" text NOT NULL,
	"directed" boolean DEFAULT false NOT NULL,
	"person_a_id" uuid NOT NULL,
	"person_b_id" uuid NOT NULL,
	"started_at" daterange,
	"started_at_granularity" date_granularity,
	"ended_at" daterange,
	"ended_at_granularity" date_granularity,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "relationship_two_people" CHECK ("relationship"."person_a_id" <> "relationship"."person_b_id"),
	CONSTRAINT "relationship_started_granularity_paired" CHECK (("relationship"."started_at" IS NULL) = ("relationship"."started_at_granularity" IS NULL)),
	CONSTRAINT "relationship_ended_granularity_paired" CHECK (("relationship"."ended_at" IS NULL) = ("relationship"."ended_at_granularity" IS NULL)),
	CONSTRAINT "relationship_ended_after_started" CHECK ("relationship"."started_at" IS NULL OR "relationship"."ended_at" IS NULL OR upper("relationship"."started_at") <= lower("relationship"."ended_at")),
	CONSTRAINT "relationship_version_or_proposal" CHECK (version IS NOT NULL OR proposal_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "relationship_content" (
	"entity_id" uuid NOT NULL,
	"version" integer,
	"proposal_id" uuid,
	"language" text NOT NULL,
	"name" text NOT NULL,
	"abstract" text,
	"description" text,
	"search_config" "regconfig" NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector("relationship_content"."search_config", coalesce("relationship_content"."name", '')), 'A') || setweight(to_tsvector("relationship_content"."search_config", coalesce("relationship_content"."abstract", '')), 'B') || setweight(to_tsvector("relationship_content"."search_config", coalesce("relationship_content"."description", '')), 'C')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "relationship_content_version_or_proposal" CHECK (version IS NOT NULL OR proposal_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "role" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "role_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "role_permission" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"role_id" uuid,
	"permission" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "role_permission_revocation_paired" CHECK (("role_permission"."revoked_at" IS NULL) = ("role_permission"."revoked_by" IS NULL)),
	CONSTRAINT "role_permission_revoked_after_granted" CHECK ("role_permission"."revoked_at" IS NULL OR "role_permission"."revoked_at" >= "role_permission"."granted_at"),
	CONSTRAINT "role_permission_shape" CHECK ("role_permission"."permission" ~ '^[a-z][a-z_]*:[a-z][a-z_]*$')
);
--> statement-breakpoint
CREATE TABLE "source" (
	"entity_id" uuid NOT NULL,
	"version" integer,
	"proposal_id" uuid,
	"identifier" text,
	"published_start" daterange,
	"published_start_granularity" date_granularity,
	"published_end" daterange,
	"published_end_granularity" date_granularity,
	"published_extent" daterange GENERATED ALWAYS AS (range_merge("source"."published_start", coalesce("source"."published_end", "source"."published_start"))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "source_published_start_granularity_paired" CHECK (("source"."published_start" IS NULL) = ("source"."published_start_granularity" IS NULL)),
	CONSTRAINT "source_published_end_granularity_paired" CHECK (("source"."published_end" IS NULL) = ("source"."published_end_granularity" IS NULL)),
	CONSTRAINT "source_published_end_needs_start" CHECK ("source"."published_start" IS NOT NULL OR "source"."published_end" IS NULL),
	CONSTRAINT "source_published_ordered" CHECK ("source"."published_end" IS NULL OR upper("source"."published_start") <= lower("source"."published_end")),
	CONSTRAINT "source_version_or_proposal" CHECK (version IS NOT NULL OR proposal_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "source_content" (
	"entity_id" uuid NOT NULL,
	"version" integer,
	"proposal_id" uuid,
	"language" text NOT NULL,
	"name" text NOT NULL,
	"abstract" text,
	"citation_text" text,
	"search_config" "regconfig" NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector("source_content"."search_config", coalesce("source_content"."name", '')), 'A') || setweight(to_tsvector("source_content"."search_config", coalesce("source_content"."abstract", '')), 'B') || setweight(to_tsvector("source_content"."search_config", coalesce("source_content"."citation_text", '')), 'C')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "source_content_version_or_proposal" CHECK (version IS NOT NULL OR proposal_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "story" (
	"entity_id" uuid NOT NULL,
	"version" integer,
	"proposal_id" uuid,
	"occurred_start" daterange,
	"occurred_start_granularity" date_granularity,
	"occurred_end" daterange,
	"occurred_end_granularity" date_granularity,
	"occurred_extent" daterange GENERATED ALWAYS AS (range_merge("story"."occurred_start", coalesce("story"."occurred_end", "story"."occurred_start"))) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "story_occurred_start_granularity_paired" CHECK (("story"."occurred_start" IS NULL) = ("story"."occurred_start_granularity" IS NULL)),
	CONSTRAINT "story_occurred_end_granularity_paired" CHECK (("story"."occurred_end" IS NULL) = ("story"."occurred_end_granularity" IS NULL)),
	CONSTRAINT "story_occurred_end_needs_start" CHECK ("story"."occurred_start" IS NOT NULL OR "story"."occurred_end" IS NULL),
	CONSTRAINT "story_occurred_ordered" CHECK ("story"."occurred_end" IS NULL OR upper("story"."occurred_start") <= lower("story"."occurred_end")),
	CONSTRAINT "story_version_or_proposal" CHECK (version IS NOT NULL OR proposal_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "story_content" (
	"entity_id" uuid NOT NULL,
	"version" integer,
	"proposal_id" uuid,
	"language" text NOT NULL,
	"name" text NOT NULL,
	"abstract" text,
	"body" text,
	"search_config" "regconfig" NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector("story_content"."search_config", coalesce("story_content"."name", '')), 'A') || setweight(to_tsvector("story_content"."search_config", coalesce("story_content"."abstract", '')), 'B') || setweight(to_tsvector("story_content"."search_config", coalesce("story_content"."body", '')), 'C')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "story_content_version_or_proposal" CHECK (version IS NOT NULL OR proposal_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"entity_id" uuid NOT NULL,
	"version" integer,
	"proposal_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "tag_version_or_proposal" CHECK (version IS NOT NULL OR proposal_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "tag_content" (
	"entity_id" uuid NOT NULL,
	"version" integer,
	"proposal_id" uuid,
	"language" text NOT NULL,
	"name" text NOT NULL,
	"abstract" text,
	"search_config" "regconfig" NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector("tag_content"."search_config", coalesce("tag_content"."name", '')), 'A') || setweight(to_tsvector("tag_content"."search_config", coalesce("tag_content"."abstract", '')), 'B')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "tag_content_version_or_proposal" CHECK (version IS NOT NULL OR proposal_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "terms" (
	"entity_id" uuid NOT NULL,
	"version" integer,
	"proposal_id" uuid,
	"effective_from" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "terms_version_or_proposal" CHECK (version IS NOT NULL OR proposal_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "terms_acceptance" (
	"user_id" uuid NOT NULL,
	"terms_entity_id" uuid NOT NULL,
	"terms_version" integer NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "terms_content" (
	"entity_id" uuid NOT NULL,
	"version" integer,
	"proposal_id" uuid,
	"language" text NOT NULL,
	"name" text NOT NULL,
	"abstract" text,
	"body" text,
	"search_config" "regconfig" NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector("terms_content"."search_config", coalesce("terms_content"."name", '')), 'A') || setweight(to_tsvector("terms_content"."search_config", coalesce("terms_content"."abstract", '')), 'B') || setweight(to_tsvector("terms_content"."search_config", coalesce("terms_content"."body", '')), 'C')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "terms_content_version_or_proposal" CHECK (version IS NOT NULL OR proposal_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "thread" (
	"entity_id" uuid PRIMARY KEY NOT NULL,
	"target_entity_id" uuid NOT NULL,
	"on_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "translation_cache" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"entity_id" uuid NOT NULL,
	"field" text NOT NULL,
	"target_language" text NOT NULL,
	"source_hash" text NOT NULL,
	"text" text NOT NULL,
	"provider" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"entity_id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"alias" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "user_person" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"person_entity_id" uuid NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "user_person_personEntityId_unique" UNIQUE("person_entity_id")
);
--> statement-breakpoint
CREATE TABLE "user_role" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_by" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "user_role_revocation_paired" CHECK (("user_role"."revoked_at" IS NULL) = ("user_role"."revoked_by" IS NULL)),
	CONSTRAINT "user_role_revoked_after_granted" CHECK ("user_role"."revoked_at" IS NULL OR "user_role"."revoked_at" >= "user_role"."granted_at")
);
--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation" ADD CONSTRAINT "citation_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation" ADD CONSTRAINT "citation_proposal_id_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation" ADD CONSTRAINT "citation_source_entity_id_entity_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation" ADD CONSTRAINT "citation_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation" ADD CONSTRAINT "citation_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_thread_id_thread_entity_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity" ADD CONSTRAINT "entity_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity" ADD CONSTRAINT "entity_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_tag" ADD CONSTRAINT "entity_tag_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_tag" ADD CONSTRAINT "entity_tag_proposal_id_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_tag" ADD CONSTRAINT "entity_tag_tag_entity_id_entity_id_fk" FOREIGN KEY ("tag_entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_tag" ADD CONSTRAINT "entity_tag_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_tag" ADD CONSTRAINT "entity_tag_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_version" ADD CONSTRAINT "entity_version_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_version" ADD CONSTRAINT "entity_version_published_by_entity_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_version" ADD CONSTRAINT "entity_version_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_version" ADD CONSTRAINT "entity_version_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link" ADD CONSTRAINT "link_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link" ADD CONSTRAINT "link_proposal_id_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link" ADD CONSTRAINT "link_target_entity_id_entity_id_fk" FOREIGN KEY ("target_entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link" ADD CONSTRAINT "link_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link" ADD CONSTRAINT "link_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_proposal_id_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_content" ADD CONSTRAINT "media_content_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_content" ADD CONSTRAINT "media_content_proposal_id_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_content" ADD CONSTRAINT "media_content_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_content" ADD CONSTRAINT "media_content_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_file" ADD CONSTRAINT "media_file_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_file" ADD CONSTRAINT "media_file_proposal_id_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_file" ADD CONSTRAINT "media_file_asset_id_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."asset"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_file" ADD CONSTRAINT "media_file_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_file" ADD CONSTRAINT "media_file_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_proposal_id_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_content" ADD CONSTRAINT "person_content_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_content" ADD CONSTRAINT "person_content_proposal_id_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_content" ADD CONSTRAINT "person_content_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_content" ADD CONSTRAINT "person_content_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place" ADD CONSTRAINT "place_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place" ADD CONSTRAINT "place_proposal_id_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place" ADD CONSTRAINT "place_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place" ADD CONSTRAINT "place_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_content" ADD CONSTRAINT "place_content_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_content" ADD CONSTRAINT "place_content_proposal_id_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_content" ADD CONSTRAINT "place_content_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_content" ADD CONSTRAINT "place_content_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_moderator_id_entity_id_fk" FOREIGN KEY ("moderator_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal" ADD CONSTRAINT "proposal_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship" ADD CONSTRAINT "relationship_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship" ADD CONSTRAINT "relationship_proposal_id_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship" ADD CONSTRAINT "relationship_person_a_id_entity_id_fk" FOREIGN KEY ("person_a_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship" ADD CONSTRAINT "relationship_person_b_id_entity_id_fk" FOREIGN KEY ("person_b_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship" ADD CONSTRAINT "relationship_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship" ADD CONSTRAINT "relationship_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_content" ADD CONSTRAINT "relationship_content_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_content" ADD CONSTRAINT "relationship_content_proposal_id_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_content" ADD CONSTRAINT "relationship_content_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_content" ADD CONSTRAINT "relationship_content_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role" ADD CONSTRAINT "role_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role" ADD CONSTRAINT "role_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_granted_by_entity_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_revoked_by_entity_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_proposal_id_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source" ADD CONSTRAINT "source_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_content" ADD CONSTRAINT "source_content_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_content" ADD CONSTRAINT "source_content_proposal_id_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_content" ADD CONSTRAINT "source_content_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_content" ADD CONSTRAINT "source_content_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story" ADD CONSTRAINT "story_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story" ADD CONSTRAINT "story_proposal_id_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story" ADD CONSTRAINT "story_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story" ADD CONSTRAINT "story_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_content" ADD CONSTRAINT "story_content_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_content" ADD CONSTRAINT "story_content_proposal_id_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_content" ADD CONSTRAINT "story_content_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_content" ADD CONSTRAINT "story_content_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_proposal_id_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_content" ADD CONSTRAINT "tag_content_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_content" ADD CONSTRAINT "tag_content_proposal_id_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_content" ADD CONSTRAINT "tag_content_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag_content" ADD CONSTRAINT "tag_content_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_proposal_id_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms_acceptance" ADD CONSTRAINT "terms_acceptance_user_id_user_entity_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms_acceptance" ADD CONSTRAINT "terms_acceptance_terms_entity_id_entity_id_fk" FOREIGN KEY ("terms_entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms_acceptance" ADD CONSTRAINT "terms_acceptance_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms_acceptance" ADD CONSTRAINT "terms_acceptance_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms_content" ADD CONSTRAINT "terms_content_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms_content" ADD CONSTRAINT "terms_content_proposal_id_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms_content" ADD CONSTRAINT "terms_content_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms_content" ADD CONSTRAINT "terms_content_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_target_entity_id_entity_id_fk" FOREIGN KEY ("target_entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_cache" ADD CONSTRAINT "translation_cache_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_cache" ADD CONSTRAINT "translation_cache_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translation_cache" ADD CONSTRAINT "translation_cache_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_person" ADD CONSTRAINT "user_person_user_id_user_entity_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_person" ADD CONSTRAINT "user_person_person_entity_id_entity_id_fk" FOREIGN KEY ("person_entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_person" ADD CONSTRAINT "user_person_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_person" ADD CONSTRAINT "user_person_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_user_id_user_entity_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("entity_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_role_id_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."role"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_granted_by_entity_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_revoked_by_entity_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_created_by_entity_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_updated_by_entity_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_sha256_idx" ON "asset" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "citation_entity_version_idx" ON "citation" USING btree ("entity_id","version");--> statement-breakpoint
CREATE INDEX "citation_proposal_idx" ON "citation" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "citation_source_idx" ON "citation" USING btree ("source_entity_id") WHERE "citation"."proposal_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "citation_published_unique" ON "citation" USING btree ("entity_id","version","source_entity_id","locator") WHERE "citation"."proposal_id" IS NULL;--> statement-breakpoint
CREATE INDEX "comment_thread_idx" ON "comment" USING btree ("thread_id","entity_id");--> statement-breakpoint
CREATE INDEX "comment_status_idx" ON "comment" USING btree ("status");--> statement-breakpoint
CREATE INDEX "entity_type_idx" ON "entity" USING btree ("type");--> statement-breakpoint
CREATE INDEX "entity_tag_entity_version_idx" ON "entity_tag" USING btree ("entity_id","version");--> statement-breakpoint
CREATE INDEX "entity_tag_proposal_idx" ON "entity_tag" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "entity_tag_tag_idx" ON "entity_tag" USING btree ("tag_entity_id") WHERE "entity_tag"."proposal_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "entity_tag_published_unique" ON "entity_tag" USING btree ("entity_id","version","tag_entity_id") WHERE "entity_tag"."proposal_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "entity_tag_proposal_unique" ON "entity_tag" USING btree ("proposal_id","tag_entity_id") WHERE "entity_tag"."proposal_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "link_entity_version_idx" ON "link" USING btree ("entity_id","version");--> statement-breakpoint
CREATE INDEX "link_proposal_idx" ON "link" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "link_target_idx" ON "link" USING btree ("target_entity_id") WHERE "link"."proposal_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "link_published_unique" ON "link" USING btree ("entity_id","version","target_entity_id") WHERE "link"."proposal_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "link_proposal_unique" ON "link" USING btree ("proposal_id","target_entity_id") WHERE "link"."proposal_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "media_published_unique" ON "media" USING btree ("entity_id","version") WHERE "media"."proposal_id" IS NULL;--> statement-breakpoint
CREATE INDEX "media_entity_version_idx" ON "media" USING btree ("entity_id","version");--> statement-breakpoint
CREATE INDEX "media_proposal_idx" ON "media" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "media_captured_idx" ON "media" USING gist ("captured");--> statement-breakpoint
CREATE INDEX "media_point_idx" ON "media" USING btree ("latitude","longitude");--> statement-breakpoint
CREATE UNIQUE INDEX "media_content_published_unique" ON "media_content" USING btree ("entity_id","version","language") WHERE "media_content"."proposal_id" IS NULL;--> statement-breakpoint
CREATE INDEX "media_content_entity_version_idx" ON "media_content" USING btree ("entity_id","version");--> statement-breakpoint
CREATE INDEX "media_content_proposal_idx" ON "media_content" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "media_content_search_idx" ON "media_content" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "media_file_entity_version_idx" ON "media_file" USING btree ("entity_id","version");--> statement-breakpoint
CREATE INDEX "media_file_proposal_idx" ON "media_file" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "media_file_asset_idx" ON "media_file" USING btree ("asset_id") WHERE "media_file"."proposal_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "media_file_one_primary" ON "media_file" USING btree ("entity_id","version") WHERE "media_file"."proposal_id" IS NULL AND "media_file"."is_primary";--> statement-breakpoint
CREATE UNIQUE INDEX "person_published_unique" ON "person" USING btree ("entity_id","version") WHERE "person"."proposal_id" IS NULL;--> statement-breakpoint
CREATE INDEX "person_entity_version_idx" ON "person" USING btree ("entity_id","version");--> statement-breakpoint
CREATE INDEX "person_proposal_idx" ON "person" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "person_born_idx" ON "person" USING gist ("born");--> statement-breakpoint
CREATE INDEX "person_died_idx" ON "person" USING gist ("died");--> statement-breakpoint
CREATE UNIQUE INDEX "person_content_published_unique" ON "person_content" USING btree ("entity_id","version","language") WHERE "person_content"."proposal_id" IS NULL;--> statement-breakpoint
CREATE INDEX "person_content_entity_version_idx" ON "person_content" USING btree ("entity_id","version");--> statement-breakpoint
CREATE INDEX "person_content_proposal_idx" ON "person_content" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "person_content_search_idx" ON "person_content" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "place_published_unique" ON "place" USING btree ("entity_id","version") WHERE "place"."proposal_id" IS NULL;--> statement-breakpoint
CREATE INDEX "place_entity_version_idx" ON "place" USING btree ("entity_id","version");--> statement-breakpoint
CREATE INDEX "place_proposal_idx" ON "place" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "place_bbox_idx" ON "place" USING btree ("min_latitude","max_latitude","min_longitude","max_longitude");--> statement-breakpoint
CREATE INDEX "place_point_idx" ON "place" USING btree ("latitude","longitude");--> statement-breakpoint
CREATE INDEX "place_validity_idx" ON "place" USING gist ("validity_extent");--> statement-breakpoint
CREATE UNIQUE INDEX "place_content_published_unique" ON "place_content" USING btree ("entity_id","version","language") WHERE "place_content"."proposal_id" IS NULL;--> statement-breakpoint
CREATE INDEX "place_content_entity_version_idx" ON "place_content" USING btree ("entity_id","version");--> statement-breakpoint
CREATE INDEX "place_content_proposal_idx" ON "place_content" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "place_content_search_idx" ON "place_content" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "proposal_entity_idx" ON "proposal" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "proposal_status_idx" ON "proposal" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "relationship_published_unique" ON "relationship" USING btree ("entity_id","version") WHERE "relationship"."proposal_id" IS NULL;--> statement-breakpoint
CREATE INDEX "relationship_entity_version_idx" ON "relationship" USING btree ("entity_id","version");--> statement-breakpoint
CREATE INDEX "relationship_proposal_idx" ON "relationship" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "relationship_person_a_idx" ON "relationship" USING btree ("person_a_id");--> statement-breakpoint
CREATE INDEX "relationship_person_b_idx" ON "relationship" USING btree ("person_b_id");--> statement-breakpoint
CREATE UNIQUE INDEX "relationship_content_published_unique" ON "relationship_content" USING btree ("entity_id","version","language") WHERE "relationship_content"."proposal_id" IS NULL;--> statement-breakpoint
CREATE INDEX "relationship_content_entity_version_idx" ON "relationship_content" USING btree ("entity_id","version");--> statement-breakpoint
CREATE INDEX "relationship_content_proposal_idx" ON "relationship_content" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "relationship_content_search_idx" ON "relationship_content" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "role_permission_active_role_idx" ON "role_permission" USING btree ("role_id") WHERE "role_permission"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "role_permission_active_unique" ON "role_permission" USING btree ("role_id","permission") WHERE "role_permission"."revoked_at" IS NULL AND "role_permission"."role_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "role_permission_active_public_unique" ON "role_permission" USING btree ("permission") WHERE "role_permission"."revoked_at" IS NULL AND "role_permission"."role_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "source_published_unique" ON "source" USING btree ("entity_id","version") WHERE "source"."proposal_id" IS NULL;--> statement-breakpoint
CREATE INDEX "source_entity_version_idx" ON "source" USING btree ("entity_id","version");--> statement-breakpoint
CREATE INDEX "source_proposal_idx" ON "source" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "source_extent_idx" ON "source" USING gist ("published_extent");--> statement-breakpoint
CREATE UNIQUE INDEX "source_content_published_unique" ON "source_content" USING btree ("entity_id","version","language") WHERE "source_content"."proposal_id" IS NULL;--> statement-breakpoint
CREATE INDEX "source_content_entity_version_idx" ON "source_content" USING btree ("entity_id","version");--> statement-breakpoint
CREATE INDEX "source_content_proposal_idx" ON "source_content" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "source_content_search_idx" ON "source_content" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "story_published_unique" ON "story" USING btree ("entity_id","version") WHERE "story"."proposal_id" IS NULL;--> statement-breakpoint
CREATE INDEX "story_entity_version_idx" ON "story" USING btree ("entity_id","version");--> statement-breakpoint
CREATE INDEX "story_proposal_idx" ON "story" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "story_extent_idx" ON "story" USING gist ("occurred_extent");--> statement-breakpoint
CREATE UNIQUE INDEX "story_content_published_unique" ON "story_content" USING btree ("entity_id","version","language") WHERE "story_content"."proposal_id" IS NULL;--> statement-breakpoint
CREATE INDEX "story_content_entity_version_idx" ON "story_content" USING btree ("entity_id","version");--> statement-breakpoint
CREATE INDEX "story_content_proposal_idx" ON "story_content" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "story_content_search_idx" ON "story_content" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_published_unique" ON "tag" USING btree ("entity_id","version") WHERE "tag"."proposal_id" IS NULL;--> statement-breakpoint
CREATE INDEX "tag_entity_version_idx" ON "tag" USING btree ("entity_id","version");--> statement-breakpoint
CREATE INDEX "tag_proposal_idx" ON "tag" USING btree ("proposal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_content_published_unique" ON "tag_content" USING btree ("entity_id","version","language") WHERE "tag_content"."proposal_id" IS NULL;--> statement-breakpoint
CREATE INDEX "tag_content_entity_version_idx" ON "tag_content" USING btree ("entity_id","version");--> statement-breakpoint
CREATE INDEX "tag_content_proposal_idx" ON "tag_content" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "tag_content_search_idx" ON "tag_content" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "terms_published_unique" ON "terms" USING btree ("entity_id","version") WHERE "terms"."proposal_id" IS NULL;--> statement-breakpoint
CREATE INDEX "terms_entity_version_idx" ON "terms" USING btree ("entity_id","version");--> statement-breakpoint
CREATE INDEX "terms_proposal_idx" ON "terms" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "terms_effective_from_idx" ON "terms" USING btree ("effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "terms_acceptance_unique" ON "terms_acceptance" USING btree ("user_id","terms_entity_id","terms_version");--> statement-breakpoint
CREATE INDEX "terms_acceptance_user_idx" ON "terms_acceptance" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "terms_content_published_unique" ON "terms_content" USING btree ("entity_id","version","language") WHERE "terms_content"."proposal_id" IS NULL;--> statement-breakpoint
CREATE INDEX "terms_content_entity_version_idx" ON "terms_content" USING btree ("entity_id","version");--> statement-breakpoint
CREATE INDEX "terms_content_proposal_idx" ON "terms_content" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "terms_content_search_idx" ON "terms_content" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "thread_target_idx" ON "thread" USING btree ("target_entity_id","on_version");--> statement-breakpoint
CREATE UNIQUE INDEX "translation_cache_key_unique" ON "translation_cache" USING btree ("entity_id","field","target_language","source_hash");--> statement-breakpoint
CREATE INDEX "translation_cache_entity_idx" ON "translation_cache" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "user_role_active_user_idx" ON "user_role" USING btree ("user_id") WHERE "user_role"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_role_active_unique" ON "user_role" USING btree ("user_id","role_id") WHERE "user_role"."revoked_at" IS NULL;