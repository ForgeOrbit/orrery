-- Ownership invariant, hardened for #24 review: enforce at least one owner for every
-- shared workspace at COMMIT, including a workspace created without one, updates that
-- change ownership eligibility, and membership moves that would empty either the old or
-- the new workspace. The function locks every affected workspace row in id order first,
-- so competing changes from any writer (service or direct SQL) serialize per workspace
-- instead of both observing an owner that the other removes.
--
-- Deferred so a valid transaction can create the workspace and its first owner in either
-- statement order, and so deleting the memberships before the workspace remains valid.
-- 0004 is already applied; this migration replaces its function and triggers in place.
CREATE OR REPLACE FUNCTION ensure_shared_workspace_has_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  workspace_ids text[];
  target_workspace text;
BEGIN
  IF TG_TABLE_NAME = 'workspaces' THEN
    workspace_ids := ARRAY[NEW.id];
  ELSE
    workspace_ids := ARRAY[]::text[];
    IF TG_OP <> 'INSERT' THEN
      workspace_ids := array_append(workspace_ids, OLD.workspace_id);
    END IF;
    IF TG_OP <> 'DELETE' THEN
      workspace_ids := array_append(workspace_ids, NEW.workspace_id);
    END IF;
  END IF;

  -- Lock every affected existing workspace in one order. The lock is what makes two
  -- transactions that each remove a different owner settle on one result: the second
  -- waits here and then re-reads the committed membership set.
  FOR target_workspace IN
    SELECT id
    FROM workspaces
    WHERE id = ANY(workspace_ids)
    ORDER BY id
    FOR UPDATE
  LOOP
    IF EXISTS (
      SELECT 1
      FROM workspaces
      WHERE id = target_workspace AND kind = 'shared'
    ) AND NOT EXISTS (
      SELECT 1
      FROM workspace_memberships
      WHERE workspace_id = target_workspace AND is_owner
    ) THEN
      RAISE EXCEPTION 'workspace % must keep at least one owner', target_workspace
        USING ERRCODE = '23514', CONSTRAINT = 'workspace_keeps_owner';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS workspace_keeps_owner ON workspace_memberships;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER workspace_keeps_owner
AFTER INSERT OR UPDATE OR DELETE ON workspace_memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_shared_workspace_has_owner();
--> statement-breakpoint
DROP TRIGGER IF EXISTS workspace_keeps_owner_on_workspaces ON workspaces;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER workspace_keeps_owner_on_workspaces
AFTER INSERT OR UPDATE ON workspaces
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ensure_shared_workspace_has_owner();
