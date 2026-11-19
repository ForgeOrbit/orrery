# Home status page

The web app's `/` page confirms the browser, the server and the database are wired
together, and shows the signed-in account's workspaces. It loads `/readyz`,
`/api/auth/session`, `/api/setup/status` and `/api/workspaces` together, then renders
one of these states:

- Fresh installation: `Orrery`, `Server: ok (dev)`, `New installation? Set up Orrery.`
- Setup complete, signed out: `Sign in to continue.`
- Signed in: `Signed in as <email>.`, heading `Your workspaces`, one list item per
  personal workspace (normally `Personal`).
- Database down on reload: `Server: unreachable` (the loader rejects).
- Database down while the page is open: `Server: degraded (dev)` on the 30s readiness
  refetch.
- Unknown client route: `Page not found.`, served by the single-page-app fallback.

The root layout puts an `Orrery` link in a `<nav>` on every route.

## Sub-features

- `home-fresh` heading, `Server: ok`, and the `Set up Orrery` link.
- `home-signed-out` `Sign in to continue.` after setup closes.
- `home-signed-in` the account line and the personal workspace list.
- `home-nav` the `Orrery` link returns to `/`.
- `home-notfound` `Page not found.` for an unknown route, with document status 200.
- `home-unreachable` `Server: unreachable` when a reload cannot load the page data.
- `home-degraded` `Server: degraded (dev)` when an open page's readiness refetch sees
  the 503.

## How to get to it (user POV)

- Open `$URL/` in a browser, signed out or signed in.
- Open any other path, such as `$URL/some/client/route`, directly (deep link) or choose
  the `Orrery` link from another page.
- Stop Postgres, then reload (unreachable) or wait on an already-open page (degraded).

## Driving it with browse.mjs

Preconditions: healthy instance, `doctor` exits 0. For the signed-in states, an account
from [accounts](./accounts.md) or [invitations](./invitations.md).

- **Fresh.** `node $SK/browse.mjs $RUN_DIR / --allow-http 401 --slug home-fresh --expect-role heading:Orrery --expect-text "Server: ok" --expect-role 'link:Set up Orrery'`.
  Exit 0, empty `problems`, screenshot shows the heading and `Server: ok (dev)`.
- **Signed out.** After setup:
  `node $SK/browse.mjs $RUN_DIR / --allow-http 401 --slug home-signed-out --expect-text "Sign in to continue."`.
- **Signed in.** `browse.mjs` fills the real form:
  `node $SK/browse.mjs $RUN_DIR /signin --allow-http 401 --slug home-signed-in --fill "Email=admin@orrery.test" --fill "Password=browser-checked-admin-password" --click-button "Sign in" --expect-text "Signed in as admin@orrery.test." --expect-role "heading:Your workspaces" --expect-text "Personal"`.
  The 401 is the session check on `/signin` before the login.
- **Navigation.** `node $SK/browse.mjs $RUN_DIR /nope --allow-http 401 --slug home-nav --click-link Orrery --expect-role heading:Orrery`.
  The `url` in the JSON is `$URL/`.
- **Not found.** `node $SK/browse.mjs $RUN_DIR /some/client/route --allow-http 401 --slug home-notfound --expect-text "Page not found."`.
  The document status is 200 (SPA fallback).
- **Unreachable.** Stop only the database container (`docker stop $CONTAINER`), then
  `node $SK/browse.mjs $RUN_DIR / --allow-http 401 --allow-http 500 --allow-http 503 --allow-console ZodError --slug home-unreachable --expect-text "Server: unreachable"`.
  The designed page is reached; the console `ZodError` is the 500 Problem parsed as the
  setup status. Restart with `docker start $CONTAINER` and poll `/readyz` back to 200.
- **Degraded.** Open `/` while the database is up, then stop it and wait up to 45s for
  `Server: degraded (dev)`; the readiness query refetches every 30s. This needs a
  one-off Playwright script that keeps the page open (the recipe above reloads instead).
  Always restart the container in a `finally`.

## Gotchas

- A signed-out home legitimately answers 401 for `/api/auth/session` and
  `/api/workspaces`; pass `--allow-http 401` or `browse.mjs` exits 1.
- A database-down **reload** shows `Server: unreachable`, not `degraded`: the loader
  also awaits `/api/setup/status`, which answers 500. `degraded` appears only on an
  open page's readiness refetch.
- `browse.mjs` records the final URL; do not point it at `/register?token=` unless you
  redact the consumed token from the evidence afterwards.
- The version shows `dev` unless `ORRERY_VERSION` is set; it does not identify the
  commit.
- Vite dev (`pnpm dev`, :5173) is not what `up` runs. `up` verifies the production build
  served by the server.
