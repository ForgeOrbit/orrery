# Writing the docs

Orrery's docs live here, in `docs/`, next to the code they describe. Change them in the same pull
request as the code, so a released version and its docs always match.

The website ([forge-orbit/orrery-site](https://github.com/forge-orbit/orrery-site)) copies this
folder when it builds and publishes it at
<https://forge-orbit.github.io/orrery-site/docs/>. You don't need to touch the website to change
the docs.

## Conventions

Write plain GitHub Markdown. Every page should read well on GitHub and on the website.

- **One file per page.** `docs/guides/install.md` becomes `/docs/guides/install/` on the website.
- **Folders become sidebar groups.** A `README.md` in a folder is that group's first page.
- **Start each page with a `# Heading`.** It becomes the page title on the website.
- **Link with relative paths**, as you would on GitHub, for example `[Install](./guides/install.md)`.
  The website rewrites them to page URLs.
- **Put images next to the page** and use relative paths.
- **Mark anything not built yet as planned.** Don't describe a feature as available until it ships.

### Optional frontmatter

Leave it out unless you need it. GitHub shows frontmatter as a table at the top of the file.

```yaml
---
title: Install            # overrides the # Heading
description: Run Orrery with docker compose.   # search results and link previews
sidebar:
  order: 1                # position in the sidebar group
---
```

## When the website updates

Every push to `main` that changes `docs/` runs
[`docs-updated.yml`](https://github.com/forge-orbit/orrery/blob/main/.github/workflows/docs-updated.yml), which tells the website to rebuild.
The new pages are usually live within a couple of minutes.

To preview your changes on the website before merging, check out `orrery-site` next to this repo
and run:

```sh
DOCS_SOURCE=../orrery npm run dev
```
