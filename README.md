# Couch

What to watch next. Couch reads your TV library from [Simkl](https://simkl.com),
fills in posters, air dates and where-to-watch from [TMDB](https://www.themoviedb.org),
and asks an LLM (via [OpenRouter](https://openrouter.ai)) to pick new shows for you,
explaining each pick in terms of what you have already watched.

- **Home:** organised by what you'd do next, TV and films side by side. *Up next*
  (shows in progress plus the next film in lists you're working through), *Ready
  tonight* (new episodes and watchlist films on your services), *Your lists*
  (progress), then coming soon, paused and long-break shows.
- **Picks:** 8 TV or film recommendations with reasons and streaming providers. Mark
  each one good or not for me; that feeds the next run.
- **Lists:** Letterboxd lists you follow (your own and liked ones from the export,
  plus any list URL you paste), with progress and what's next. Read from the public
  list page at most once a week (Re-read on a list page anytime).
- **Library:** your Simkl shows by status, with ratings and progress.
- **Taste:** the written taste profile picks are based on, plus your own notes to
  correct it.

Films come from your Letterboxd export plus your public diary RSS feed (set
`LETTERBOXD_USERNAME`), so new watches show up without re-exporting.

Couch only reads from Simkl; it never changes your Simkl library.

## How picks work

1. **Taste profile** (cheap model, rebuilt only when your history changes). One call
   reads your Simkl shows (ratings, completed, on hold, dropped), your Letterboxd
   film ratings and reviews, your notes, and your feedback on past picks, and writes
   a short profile.
2. **Candidates** (no LLM). TMDB recommendations for your best-rated shows,
   well-rated shows on your streaming services, and this week's trending. Anything
   in your library or rejected before is dropped, then ~60 are kept.
3. **The pick** (default `openai/gpt-5.6-luna`, override with `OPENROUTER_PICK_MODEL` or `--model`). One call gets the profile and the candidates and
   returns 8 picks with reasons. A run costs well under a cent and only happens when you
   click **New picks** (or run `picks --new`).

## Setup

Needs Node 24+.

```sh
npm install
cp .env.example .env   # fill it in; see the comments
```

You need:

- **Simkl client ID:** create an app at https://simkl.com/settings/developer/ with
  type **TV / devices / CLI** (that type allows the code-based login).
- **TMDB API key:** https://www.themoviedb.org/settings/api
- **OpenRouter API key:** https://openrouter.ai/keys
- Optional: your **Letterboxd export** (Settings > Import & Export) unzipped into
  `data/`, so film taste feeds the profile.
- Optional: a **Chatterbox** app name and secret to ship logs there.

## Running

```sh
npm run dev                  # web UI on http://localhost:3000
npm run cli -- login         # connect Simkl from the terminal instead
npm run cli -- sync          # pull your library
npm run cli -- up-next
npm run cli -- picks --new   # generate picks (OpenRouter)
npm run cli -- taste
npm run cli -- status
```

The server also syncs in the background every `COUCH_SYNC_HOURS` (default 6). An
unchanged library costs one Simkl API call, well inside the free 500 a day.

## Development

```sh
npm test            # node:test, runs from TypeScript source
npm run typecheck
npm run check       # biome lint + format check
npm run format
```

Layout:

- `src/server/` is the core: Simkl, TMDB, SQLite (`node:sqlite`), taste profile,
  picks, logging. It imports only `node:` builtins and sibling modules, so the CLI
  runs with no build step and no `node_modules`.
- `src/server/fns.ts` holds the TanStack Start server functions: the UI's whole API.
- `src/routes/` and `src/components/` are the UI. The theme is the Sunset-vault
  token set shared with the comics app.

## Deploy

Same pattern as the comics stack: push to `main`, GitHub Actions tests and builds
the image, pushes it to GHCR, then calls Coolify's deploy webhook.

One-time setup:

1. In Coolify: **New Resource > Docker Compose**, pointed at this repository. Leave
   the domain field empty; routing comes from the labels in `docker-compose.yml`
   (`couch.otagera.xyz`).
2. Set the environment variables from `.env.example`, including `COUCH_SETUP_CODE`
   (the app is open without it) and `COUCH_IMAGE=ghcr.io/otagera/couch:latest`.
3. DNS: point `couch.otagera.xyz` at the host, proxying off.
4. Repository secrets: `COOLIFY_WEBHOOK_URL` and `COOLIFY_TOKEN`, as in comics.
5. Optional: copy your Letterboxd CSVs to `/mnt/HC_Volume_106816620/couch/letterboxd/`.

Then open the site, enter the setup code to create your passkey (fingerprint or
face), and click **Connect Simkl**.

### Sign-in

Couch signs in with passkeys only. The setup code registers the first one; after
that, add devices from **Passkeys** (footer): passkeys synced by iCloud Keychain or
Google Password Manager just work, and any other device can be added with a
one-time 10-minute code. Locked out? Run `node src/server/cli.ts passkeys reset`
in the container and use the setup code again.

Maintenance CLI inside the container:

```sh
docker exec $(docker ps -qf label=couch.role=web) node src/server/cli.ts status
```

## Data and attribution

TV data from Simkl and TMDB. This product uses the TMDB API but is not endorsed or
certified by TMDB.

The previous Letterboxd movie CLI lives at the `v1-movies-cli` tag.
