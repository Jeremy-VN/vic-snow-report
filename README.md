# Victoria Snow Report — web version

One public web page with four tabs: **Falls Creek · Mount Hotham · Mount Buller · Snow history**.
It's a single self-contained `index.html` — no build step, no dependencies, no server code.
(The Snow history tab is the full 12-season Falls Creek / ENSO analysis.)

## Files
- `index.html` — the whole site.
- `package.json` — metadata only (not required to run).

## Deploy on Vercel via GitHub (recommended, free)

1. **Create a GitHub repo** (Private is fine), e.g. `vic-snow-report`, and put this
   folder's contents in it.
2. **Vercel** → sign up / log in **with GitHub** → "Add New… → Project" → import the repo.
   - Framework preset: **Other** (it's a static site). No build command, no settings.
   - Deploy. You'll get `https://vic-snow-report.vercel.app` (or similar).
3. Share that link. `<meta name="robots" content="noindex">` keeps it out of search results.

## How ongoing updates work (your question)

GitHub keeps a full, timestamped history of every change ("commit"). Vercel watches your
repo and **auto-redeploys within ~30 seconds of any push to the main branch**. So the loop is:

```
edit index.html  →  commit  →  push to GitHub  →  Vercel redeploys  →  live URL updates
```

There are two kinds of update:

**1. Design / content changes** (you or Claude change how the page looks or what it says)
   - Edit `index.html`, commit, push. Done. Vercel redeploys.
   - You can edit straight on github.com (pencil icon → commit) — easiest while learning —
     or locally with `git`, or have Claude regenerate the file and you push it.
   - Every push is a restore point: GitHub → repo → "commits" shows the history, and you can
     revert any change.

**2. Daily data refresh** (the forecast / conditions numbers)
   - The data is currently baked into `index.html` as a snapshot (built 24 Jun 2026).
   - The in-app artefact already refreshes nightly inside Claude. To make the **public page**
     refresh too, the nightly task needs to write the new `index.html` here and `git push` it.
     That requires a stored GitHub token for the task — a one-time setup we can do together.
   - Honest note: a static site only changes when something pushes a new file. If you later
     want the public page to refresh *on every visit* without any push, that's the serverless
     route (it can't reproduce the curated conditions strip / snowmaking column, so we chose
     this richer static version instead).

## Updating from the command line (optional, for learning git)
```
git add index.html
git commit -m "Update snow data 24 Jun"
git push
```
Vercel redeploys automatically.
