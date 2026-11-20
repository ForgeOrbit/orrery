-- Agent API key project grants (issue #30): a key is scoped to exactly one workspace,
-- so every project it may act on must belong to that same workspace. The service checks
-- this when a key is issued; this trigger is the database-level second line of defence
-- for any writer that bypasses it. The cross-table fact cannot be a CHECK constraint.
CREATE OR REPLACE FUNCTION ensure_agent_key_project_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  key_workspace text;
  project_workspace text;
BEGIN
  SELECT k.workspace_id
    INTO key_workspace
  FROM agent_api_keys k
  WHERE k.id = NEW.key_id;

  SELECT p.workspace_id
    INTO project_workspace
  FROM projects p
  WHERE p.id = NEW.project_id;

  -- Missing rows are the foreign keys' concern, not this trigger's.
  IF key_workspace IS NULL OR project_workspace IS NULL THEN
    RETURN NEW;
  END IF;

  IF key_workspace <> project_workspace THEN
    RAISE EXCEPTION 'project % is outside the workspace of agent key % (constraint agent_key_project_workspace)',
      NEW.project_id, NEW.key_id
      USING ERRCODE = '23514', CONSTRAINT = 'agent_key_project_workspace';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agent_key_project_scope
BEFORE INSERT OR UPDATE ON agent_api_key_projects
FOR EACH ROW EXECUTE FUNCTION ensure_agent_key_project_scope();
