-- Historical rows already marked expired kept no timestamp. The deadline is the moment
-- they expired, so use the deadline both tables already recorded (issue #25).
UPDATE "invitations"
SET "expired_at" = "expires_at"
WHERE "status" = 'expired' AND "expired_at" IS NULL;--> statement-breakpoint
UPDATE "workspace_invitations"
SET "expired_at" = "expires_at"
WHERE "status" = 'expired' AND "expired_at" IS NULL;
