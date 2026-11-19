-- Per-workspace ownership serialization for #24 review. A guard row is the single
-- mutation boundary: service writes update it before invitations or memberships, and
-- BEFORE triggers update it for direct membership/workspace writes. The update advances
-- a version, so under REPEATABLE READ a transaction whose snapshot went stale fails with
-- a serialization error instead of committing an ownerless workspace. Lock order is
-- always guard rows, in workspace-id order, before the membership or workspace row.
--
-- Maintenance behavior: delete workspace_events, workspace_invitations,
-- workspace_memberships, then workspaces in one transaction. TRUNCATE is refused for
-- memberships and workspaces because statement truncation bypasses row triggers and
-- could leave a shared workspace without an owner. Ordinary workspace deletion stays
-- supported; deferred owner checks skip a workspace that is gone at COMMIT.
INSERT INTO workspace_ownership_guards (workspace_id, version)
SELECT id, 0 FROM workspaces
ON CONFLICT (workspace_id) DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION touch_workspace_ownership_guards() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  workspace_ids text[];
  target_workspace text;
BEGIN
  IF TG_TABLE_NAME = 'workspaces' THEN
    workspace_ids := ARRAY[]::text[];
    IF TG_OP <> 'INSERT' THEN
      workspace_ids := array_append(workspace_ids, OLD.id);
    END IF;
    IF TG_OP <> 'DELETE' THEN
      workspace_ids := array_append(workspace_ids, NEW.id);
    END IF;
  ELSE
    workspace_ids := ARRAY[]::text[];
    IF TG_OP <> 'INSERT' THEN
      workspace_ids := array_append(workspace_ids, OLD.workspace_id);
    END IF;
    IF TG_OP <> 'DELETE' THEN
      workspace_ids := array_append(workspace_ids, NEW.workspace_id);
    END IF;
  END IF;

  -- One deterministic order for every writer. The update itself is the serialization
  -- point: a stale REPEATABLE READ transaction cannot advance a guard another writer
  -- already advanced.
  FOR target_workspace IN
    SELECT DISTINCT value
    FROM unnest(workspace_ids) AS ids(value)
    ORDER BY value
  LOOP
    INSERT INTO workspace_ownership_guards (workspace_id, version)
    VALUES (target_workspace, 1)
    ON CONFLICT (workspace_id) DO UPDATE
      SET version = workspace_ownership_guards.version + 1;
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_workspace_ownership_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO workspace_ownership_guards (workspace_id, version)
  VALUES (NEW.id, 0)
  ON CONFLICT (workspace_id) DO NOTHING;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- The invariant check no longer takes its own locks. Serialization already happened on
-- the guard before the membership/workspace mutation; this deferred check only verifies
-- the committed shape, so valid creation and deletion remain transactional.
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

  FOR target_workspace IN
    SELECT DISTINCT value
    FROM unnest(workspace_ids) AS ids(value)
    ORDER BY value
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
CREATE OR REPLACE FUNCTION refuse_workspace_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% cannot be truncated; delete the affected rows in one transaction', TG_TABLE_NAME
    USING ERRCODE = '23514', CONSTRAINT = 'workspace_truncate_guard';
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS workspace_ownership_guard_created ON workspaces;
--> statement-breakpoint
CREATE TRIGGER workspace_ownership_guard_created
AFTER INSERT ON workspaces
FOR EACH ROW EXECUTE FUNCTION create_workspace_ownership_guard();
--> statement-breakpoint
DROP TRIGGER IF EXISTS workspace_ownership_guard_touched ON workspaces;
--> statement-breakpoint
CREATE TRIGGER workspace_ownership_guard_touched
BEFORE UPDATE OR DELETE ON workspaces
FOR EACH ROW EXECUTE FUNCTION touch_workspace_ownership_guards();
--> statement-breakpoint
DROP TRIGGER IF EXISTS workspace_ownership_guard_touched ON workspace_memberships;
--> statement-breakpoint
CREATE TRIGGER workspace_ownership_guard_touched
BEFORE INSERT OR UPDATE OR DELETE ON workspace_memberships
FOR EACH ROW EXECUTE FUNCTION touch_workspace_ownership_guards();
--> statement-breakpoint
DROP TRIGGER IF EXISTS workspace_memberships_truncate_guard ON workspace_memberships;
--> statement-breakpoint
CREATE TRIGGER workspace_memberships_truncate_guard
BEFORE TRUNCATE ON workspace_memberships
FOR EACH STATEMENT EXECUTE FUNCTION refuse_workspace_truncate();
--> statement-breakpoint
DROP TRIGGER IF EXISTS workspace_truncate_guard ON workspaces;
--> statement-breakpoint
CREATE TRIGGER workspace_truncate_guard
BEFORE TRUNCATE ON workspaces
FOR EACH STATEMENT EXECUTE FUNCTION refuse_workspace_truncate();
