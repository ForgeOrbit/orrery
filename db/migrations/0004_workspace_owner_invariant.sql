-- Ownership invariant (issue #24): a shared workspace must always keep at least one
-- owner. The service serializes ownership changes on the workspace row, and this
-- deferred constraint trigger is the database-level second line of defence for any
-- writer that bypasses it. Deferred so a multi-statement transaction can create the
-- workspace and its first owner in either statement order; it fires at COMMIT.
CREATE OR REPLACE FUNCTION ensure_shared_workspace_has_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_workspace text;
BEGIN
  target_workspace := COALESCE(NEW.workspace_id, OLD.workspace_id);

  -- Personal workspaces keep their owner on the workspaces row, not here. Only a
  -- workspace that still exists is checked; a missing row is the FK's concern.
  IF EXISTS (SELECT 1 FROM workspaces WHERE id = target_workspace) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM workspace_memberships
      WHERE workspace_id = target_workspace AND is_owner
    ) THEN
      RAISE EXCEPTION 'workspace % must keep at least one owner', target_workspace
        USING ERRCODE = '23514', CONSTRAINT = 'workspace_keeps_owner';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER workspace_keeps_owner
AFTER INSERT OR UPDATE OR DELETE ON workspace_memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_shared_workspace_has_owner();
