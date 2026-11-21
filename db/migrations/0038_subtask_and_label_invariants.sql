-- #97: cross-row invariants a CHECK cannot express. Both triggers use SQLSTATE 23514 so a
-- bypassing writer sees the same "check violation" family as the service's refusals.

-- A subtask must be exactly one level below its parent. Lock the two issue rows in ascending
-- id order before reading them, matching the service's project -> id-sorted-issues order, so
-- two concurrent reparentings cannot both observe an old tree and commit depth 2.
CREATE OR REPLACE FUNCTION enforce_issue_subtask_tree() RETURNS trigger AS $$
DECLARE
  parent_project text;
  parent_parent text;
  parent_found boolean;
BEGIN
  -- A project-scoped parent cannot move to another project while its subtasks stay behind.
  -- This must be checked before the no-parent early return: a parent has no parent of its
  -- own, but it may still have children whose project_id must keep matching it.
  IF TG_OP = 'UPDATE' AND NEW.project_id <> OLD.project_id AND EXISTS (
    SELECT 1 FROM issues WHERE parent_issue_id = NEW.id AND project_id <> NEW.project_id
  ) THEN
    RAISE EXCEPTION 'a parent issue cannot change project while its subtasks stay in the old project' USING ERRCODE = '23514';
  END IF;
  IF NEW.parent_issue_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.parent_issue_id = NEW.id THEN
    RAISE EXCEPTION 'an issue cannot be its own parent' USING ERRCODE = '23514';
  END IF;

  IF NEW.id < NEW.parent_issue_id THEN
    PERFORM 1 FROM issues WHERE id = NEW.id FOR UPDATE;
    SELECT project_id, parent_issue_id INTO parent_project, parent_parent
      FROM issues WHERE id = NEW.parent_issue_id FOR UPDATE;
    parent_found := FOUND;
  ELSE
    SELECT project_id, parent_issue_id INTO parent_project, parent_parent
      FROM issues WHERE id = NEW.parent_issue_id FOR UPDATE;
    parent_found := FOUND;
    PERFORM 1 FROM issues WHERE id = NEW.id FOR UPDATE;
  END IF;

  IF NOT parent_found THEN
    RAISE EXCEPTION 'the parent issue does not exist' USING ERRCODE = '23503';
  END IF;
  IF parent_project <> NEW.project_id THEN
    RAISE EXCEPTION 'a subtask and its parent must be in the same project' USING ERRCODE = '23514';
  END IF;
  IF parent_parent IS NOT NULL THEN
    RAISE EXCEPTION 'maximum subtask depth is one: a subtask cannot have children' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM issues WHERE parent_issue_id = NEW.id) THEN
    RAISE EXCEPTION 'an issue with subtasks cannot become a subtask' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER issues_subtask_tree BEFORE INSERT OR UPDATE OF parent_issue_id, project_id ON issues
  FOR EACH ROW EXECUTE FUNCTION enforce_issue_subtask_tree();
--> statement-breakpoint

-- A label is project-scoped: it cannot be attached to an issue in a different project.
CREATE OR REPLACE FUNCTION enforce_issue_label_project() RETURNS trigger AS $$
DECLARE
  issue_project text;
  label_project text;
BEGIN
  SELECT project_id INTO issue_project FROM issues WHERE id = NEW.issue_id;
  SELECT project_id INTO label_project FROM project_labels WHERE id = NEW.label_id;
  IF issue_project IS DISTINCT FROM label_project THEN
    RAISE EXCEPTION 'a label can only be attached to an issue in the same project' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER issue_labels_same_project BEFORE INSERT OR UPDATE ON issue_labels
  FOR EACH ROW EXECUTE FUNCTION enforce_issue_label_project();
