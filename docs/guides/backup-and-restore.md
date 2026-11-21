# Backup and restore

Orrery stores its data in the Compose Postgres service (`postgres:18`) on the `pgdata` volume. The
commands below run through `docker compose exec` against that service and produce a portable
custom-format dump. Run them from the repository root, where `compose.yaml` and `.env` live.

> **Back up `.env` separately — it is not in the database dump.** In particular, preserve
> `ORRERY_ENCRYPTION_KEY`: it encrypts instance secrets at rest
> ([ADR-0004](../adr/0004-encrypt-instance-secrets-at-rest.md)). A `pg_dump` contains the encrypted
> values but **not the key**. If you restore the dump with a different or missing key, the saved
> SMTP password becomes unreadable (and, when outgoing webhooks ship, so do their signing secrets).
> Keep a copy of `.env`, or at least of `ORRERY_ENCRYPTION_KEY`, alongside every dump in secure
> storage. Also note `POSTGRES_PASSWORD` and the current `ORRERY_VERSION` so the stack can be
> rebuilt exactly.

## Back up

Stopping writers is not required for a consistent dump: `pg_dump` takes a consistent snapshot while
the app keeps running.

```sh
docker compose exec -T postgres pg_dump -U orrery -d orrery -Fc > orrery-backup.dump
```

`-Fc` writes a custom-format binary dump; `-T` disables the pseudo-TTY so the binary is not corrupted
by terminal translation. Pick your own filename (a timestamped one is a good habit).

Check that the dump is readable before you rely on it:

```sh
docker compose exec -T postgres pg_restore -l < orrery-backup.dump | head
```

That lists the archive contents without touching the live database. Store the dump and your `.env`
copy somewhere off the host.

## Restore

Restoring replaces the database, so do it during a maintenance window. Stop the app first so no
writes race the restore; Postgres itself stays up.

```sh
docker compose stop orrery
docker compose exec -T postgres psql -U orrery -d postgres -c 'DROP DATABASE IF EXISTS orrery;'
docker compose exec -T postgres psql -U orrery -d postgres -c 'CREATE DATABASE orrery;'
docker compose exec -T postgres pg_restore -U orrery -d orrery --no-owner --no-privileges < orrery-backup.dump
docker compose start orrery
```

`--no-owner --no-privileges` makes the restore work when the original role OIDs differ from the new
ones; ownership and grants come from the fresh database. The Postgres volume is kept — only the
`orrery` database inside it is recreated. Do **not** run `docker compose down -v` as part of a
restore: `-v` deletes the volume that holds the database.

## Verify the restore

1. Confirm the archive restored real objects and the server is healthy:

   ```sh
   docker compose exec -T postgres psql -U orrery -d orrery -c '\dt'
   curl -fsS http://localhost:8080/healthz
   curl -fsS http://localhost:8080/readyz
   ```

   `\dt` must list the Orrery tables; both endpoints must return HTTP 200.

2. Sign in at `PUBLIC_URL` and spot-check a known project, issue and comment. The `KEY-N` issue
   identifiers and the issue's activity history should match the pre-backup state.

3. Open the installation's SMTP settings. A previously saved password still works only if
   `ORRERY_ENCRYPTION_KEY` was restored unchanged; if it is missing, the settings cannot decrypt it
   and you must re-enter the password (or restore the original key).

4. Check `docker compose logs -f orrery` for startup or migration errors.

## Upgrade and rollback checklist

Use this around any image upgrade (`ORRERY_VERSION`) as well as a restore:

- [ ] Record the currently running tag (`ORRERY_VERSION` in `.env`) and the dump filename.
- [ ] Take a fresh backup, verify it with `pg_restore -l`, and confirm the `.env` copy containing
      `ORRERY_ENCRYPTION_KEY` is stored with it.
- [ ] Pin the new tag, then `docker compose pull orrery` and `docker compose up -d orrery`.
      Migrations are applied from `db/migrations/` at startup; the data volume is preserved.
- [ ] Verify `/healthz` and `/readyz`, sign in, and spot-check a project and issue.
- [ ] If the upgrade fails: restore the dump with the **restore** commands above, set
      `ORRERY_VERSION` back to the recorded tag, `docker compose pull orrery`,
      `docker compose up -d orrery`, then repeat the verification steps.
