# Home status page

The web app's home page confirms the browser, the server and the database are wired together: it shows the Orrery heading and `Server: <status> (<version>)`, fetched from `/readyz`. Unknown client routes show `Page not found.`.

## Sub-features

- `home-ready` shows `Server: ok (dev)` when the database is reachable.
- `home-nav` has an `Orrery` link in the page header that returns to `/`.
- `home-notfound` shows `Page not found.` for an unknown route, served by the single-page-app fallback.
- `home-degraded` shows `Server: degraded (dev)` when the database is down.

## How to get to it (user POV)

- Open `$URL/` in a browser.
- Open any other path, such as `$URL/some/client/route`, directly (deep link) or choose the `Orrery` link from another page.

## Driving it with browse.mjs

Preconditions: healthy instance, `doctor` exits 0.

- **Home ready.** `node $SK/browse.mjs $RUN_DIR / --expect-role heading:Orrery --expect-text "Server: ok"`. Exit 0, empty `problems`, `home.png` shows the heading and `Server: ok (dev)`.
- **Navigation.** `node $SK/browse.mjs $RUN_DIR /nope --click-link Orrery --expect-role heading:Orrery`. Ends back on `/` (the `url` in the JSON).
- **Not found.** `node $SK/browse.mjs $RUN_DIR /some/client/route --expect-text "Page not found."`. The document status is 200 (SPA fallback), the page shows the message.
- **Degraded.** Stop only the database container (`docker stop $CONTAINER`), reload `/`: the page shows `Server: degraded (dev)` because `/readyz` returns 503 with a JSON body. Restart it with `docker start $CONTAINER` afterwards. `browse.mjs` reports the 503 as a problem; that is expected here, so read the screenshot rather than the exit code.

## Gotchas

- `browse.mjs` treats any HTTP >= 400 as a failure, so the degraded recipe exits 1 by design.
- The version shows `dev` unless `ORRERY_VERSION` is set; it does not identify the commit.
- `Server: unreachable` (the router error component) is not mapped: it needs the readiness fetch to fail outright while the page itself loaded, and no recipe here does that without stopping the server.
- Vite dev (`pnpm dev`, :5173) is not what `up` runs. `up` verifies the production build served by the server.
