-- Project access scope (issue #27): an explicit grant may only exist for a project in a
-- shared workspace, and only for a human who is a current member of that workspace.
-- These are cross-table invariants, so a CHECK cannot express them. The service enforces
-- both, and this trigger is the database-level second line of defence for any writer
-- that bypasses it. The unique index and level CHECK are in 0011.
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

  -- Project access is granted to members of the owning workspace, never to outsiders.
  IF NOT EXISTS (
    SELECT 1
    FROM workspace_memberships
    WHERE workspace_id = project_workspace
      AND human_id = NEW.human_id
  ) THEN
    RAISE EXCEPTION 'human % is not a member of the workspace owning project % (constraint project_access_grant_member)',
      NEW.human_id, NEW.project_id
      USING ERRCODE = '23503', CONSTRAINT = 'project_access_grant_member';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_access_grant_scope
BEFORE INSERT OR UPDATE ON project_access_grants
FOR EACH ROW EXECUTE FUNCTION ensure_project_access_grant_scope();
