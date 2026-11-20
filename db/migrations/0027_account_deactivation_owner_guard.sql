-- Account deactivation (#38). Two database-level guards are tightened in place:
--
-- 1. A shared workspace may briefly have zero *active* owners when its only owner is
--    deactivated. Deactivation suspends that membership in place, keeps is_owner's old
--    value in is_former_owner, and clears is_owner/can_*; the deferred check must accept
--    that shape, because the row is deliberately kept for ownership recovery (#43). It
--    still refuses to create or leave an ownerless workspace with no such suspended
--    former owner, so ordinary removals cannot break the invariant. Reactivation does not
--    touch memberships, so the workspace stays in exactly this recoverable state.
--
-- 2. A project access grant now requires an *active* membership, not merely a row.
--    Deactivation revokes every grant before suspending, and re-invitation unsuspends the
--    membership before granting fresh access, so both flows keep the stricter rule.
-- 0007 and 0012 are already applied; this migration replaces their functions in place.
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
      -- An active owner keeps the workspace administered. A deactivated former owner is
      -- retained as is_former_owner = true with suspended_at set, which is the one
      -- deliberate zero-active-owner shape (#38 -> #43).
      SELECT 1
      FROM workspace_memberships
      WHERE workspace_id = target_workspace
        AND is_owner
        AND suspended_at IS NULL
    ) AND NOT EXISTS (
      SELECT 1
      FROM workspace_memberships
      WHERE workspace_id = target_workspace
        AND suspended_at IS NOT NULL
        AND is_former_owner
    ) THEN
      RAISE EXCEPTION 'workspace % must keep at least one owner', target_workspace
        USING ERRCODE = '23514', CONSTRAINT = 'workspace_keeps_owner';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ensure_project_access_grant_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  project_workspace text;
  workspace_kind text;
BEGIN
  SELECT p.workspace_id, w.kind
    INTO project_workspace, workspace_kind
  FROM projects p
  JOIN workspaces w ON w.id = p.workspace_id
  WHERE p.id = NEW.project_id;

  -- A missing project is the foreign key's concern, not this trigger's.
  IF workspace_kind IS NULL THEN
    RETURN NEW;
  END IF;

  -- Personal projects have no direct human collaborators (#20).
  IF workspace_kind <> 'shared' THEN
    RAISE EXCEPTION 'project % belongs to a personal workspace (constraint project_access_grant_shared_only)',
      NEW.project_id
      USING ERRCODE = '23514', CONSTRAINT = 'project_access_grant_shared_only';
  END IF;

  -- Project access is granted to *active* members of the owning workspace, never to
  -- outsiders or to a membership suspended by account deactivation (#38).
  IF NOT EXISTS (
    SELECT 1
    FROM workspace_memberships
    WHERE workspace_id = project_workspace
      AND human_id = NEW.human_id
      AND suspended_at IS NULL
  ) THEN
    RAISE EXCEPTION 'human % is not a member of the workspace owning project % (constraint project_access_grant_member)',
      NEW.human_id, NEW.project_id
      USING ERRCODE = '23503', CONSTRAINT = 'project_access_grant_member';
  END IF;

  RETURN NEW;
END;
$$;
