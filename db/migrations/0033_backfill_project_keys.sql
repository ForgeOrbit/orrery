-- #95 project key: derive a valid, workspace-unique uppercase key for every existing
-- project so an upgrade needs no manual backfill. Keys come from the initials of the
-- name's words; collisions inside a workspace get a deterministic numeric suffix in
-- (created_at, id) order. The format and the unique index are added in the next migration.
WITH derived AS (
  SELECT
    p.id,
    p.workspace_id,
    CASE
      WHEN letters = '' THEN 'PRJ'
      WHEN length(letters) = 1 THEN letters || 'J'
      ELSE left(letters, 8)
    END AS base_key
  FROM "projects" p
  CROSS JOIN LATERAL (
    SELECT upper(coalesce(array_to_string(array(
      SELECT left(part[1], 1)
      FROM regexp_matches(p.name, '[A-Za-z]+', 'g') AS part
    ), ''), '')) AS letters
  ) AS extracted
),
numbered AS (
  SELECT
    derived.id,
    derived.base_key,
    row_number() OVER (
      PARTITION BY derived.workspace_id, derived.base_key
      ORDER BY p.created_at, p.id
    ) AS collision
  FROM derived
  INNER JOIN "projects" p ON p.id = derived.id
)
UPDATE "projects" p
SET "key" = CASE
  WHEN numbered.collision = 1 THEN numbered.base_key
  ELSE left(numbered.base_key, 10 - length(numbered.collision::text)) || numbered.collision::text
END
FROM numbered
WHERE p.id = numbered.id AND p."key" IS NULL;
