-- Take the ownership write lock before PostgreSQL locks target rows. UPDATE and
-- DELETE already hold target rows when their row-level triggers run. Keep the
-- per-workspace versions and deferred owner checks from 0007 for stale snapshots.
-- This intentionally serializes ownership mutations across the installation.
-- Maintenance transactions must take this lock before explicitly locking rows
-- that participate in an ownership mutation.
CREATE FUNCTION lock_workspace_ownership_writes() RETURNS void
LANGUAGE sql VOLATILE AS $$
  SELECT pg_advisory_xact_lock(61683814, 24);
$$;
--> statement-breakpoint
CREATE FUNCTION lock_workspace_ownership_statement() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM lock_workspace_ownership_writes();
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER workspace_ownership_write_order
BEFORE INSERT OR UPDATE OR DELETE ON workspace_memberships
FOR EACH STATEMENT EXECUTE FUNCTION lock_workspace_ownership_statement();
--> statement-breakpoint
CREATE TRIGGER workspace_ownership_write_order
BEFORE UPDATE OR DELETE ON workspaces
FOR EACH STATEMENT EXECUTE FUNCTION lock_workspace_ownership_statement();
