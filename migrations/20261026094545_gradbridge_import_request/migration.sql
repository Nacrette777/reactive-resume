CREATE TABLE "resume_import_request" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"request_id" text NOT NULL,
	"resume_id" text,
	"payload_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resume_import_request_user_id_request_id_unique" UNIQUE("user_id","request_id")
);
--> statement-breakpoint
CREATE INDEX "resume_import_request_resume_id_index" ON "resume_import_request" ("resume_id");--> statement-breakpoint
ALTER TABLE "resume_import_request" ADD CONSTRAINT "resume_import_request_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "resume_import_request" ADD CONSTRAINT "resume_import_request_resume_id_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "resume"("id") ON DELETE SET NULL;--> statement-breakpoint
-- Earlier imports recorded their requestId only in the slug (gb-<requestId>). Carry those over so
-- their retries still resolve; imports whose slug was already edited cannot be recovered.
INSERT INTO "resume_import_request" ("id", "user_id", "request_id", "resume_id", "payload_sha256", "created_at")
SELECT gen_random_uuid()::text, "user_id", substring("slug" from 4), "id", NULL, "created_at"
FROM "resume"
WHERE "slug" ~ '^gb-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
