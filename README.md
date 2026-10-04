# Lavish Library

A private, local-first browser library for finding and reopening Lavish review surfaces on a Mac.

## What it does

- Reads Lavish's central session history from `~/.lavish-axi/state.json`
- Automatically groups known artifacts by project
- Finds additional HTML artifacts in project `.lavish` folders (generated `.export.html` and `-portable.html` copies are omitted unless opened in Lavish)
- Shows session state, server availability, last-used time, edit time, and file size
- Explains Lavish's recorded artifact/local-asset failures separately from server availability
- Shows agent-declared revision context on saved artifact timelines and reveals local `server.log` in Finder when available
- Searches, filters, sorts, and switches between grid and list views
- Opens or reopens an artifact with `lavish-axi`
- Reveals an artifact in Finder
- Adds project folders with a native macOS folder picker or a pasted path
- Creates content-addressed snapshots whenever a watched Lavish changes
- Copies each HTML file and its linked local assets into a chosen archive folder
- Shows an artifact timeline with size/line deltas, archived previews, and safe restore
- Records local searches, opens, reveals, restores, feedback, and outcomes from v0.2 onward
- Classifies recurring topics and artifact shapes without uploading content
- Combines Lavish sessions, protected versions, local interactions, and project Git activity into a plan-evolution timeline
- Provides a Signal Observatory, periodic Lavish Review, dormant gems, template candidates, and an explainable recommendation queue
- Lets you tune on-demand, weekly, monthly, and contextual reflection prompts

All project paths and preferences stay on the Mac in `~/.lavish-tracker/config.json`. Insights and feedback stay in `~/.lavish-tracker/analytics.json`. Nothing is uploaded by the app, and foreground-time tracking is deliberately excluded.

## Insights

The sidebar exposes two complementary destinations directly:

- **Signal Observatory** shows the evidence: activity, repeat-use signals, topic shelves, searches, recurring Lavish shapes, and the evolving timeline of versions, sessions, restores, feedback, and Git commits.
- **Lavish Review** turns that evidence into a calm narrative, an actionable recommendation queue, dormant work worth revisiting, possible templates, and quick value/outcome labels.

The app distinguishes recorded evidence from unknown history. It can backfill file dates, known Lavish sessions, protected versions, and local Git commits; searches and library interactions begin recording with v0.2. Artifacts labelled **Disposable** or **Abandoned** are excluded from dormant gems even when they have revisions or agent replies.

## Versions

- `v0.1.0` — local Lavish library and protected version archive
- `v0.2.0` — Signal Observatory, Lavish Review, feedback, recommendations, and plan evolution

Releases follow semantic versioning. Conventional `fix:`, `feat:`, and breaking-change commits are collected by Release Please into a version-and-changelog pull request; merging that pull request creates the matching GitHub Release and `vX.Y.Z` tag. The project is not published to npm.

See [CHANGELOG.md](CHANGELOG.md) for the release history.

## Version archive

Choose **Set up archive** in the app and select any local or synced folder. The app creates a readable `Lavish Library Archive` beneath it, grouped by project and artifact. Each version has its own HTML file, local assets, a complete bundle checksum, timestamps, and manifest entry. Identity includes the HTML bytes and the paths, bytes, and availability of its bounded local dependencies, so CSS and image edits create versions even when HTML is unchanged.

The first scan creates a baseline. While the app is running, watched files are backed up shortly after each saved change; a 30-second reconciliation scan catches new artifacts and anything a watcher missed. Restoring an older version archives the current bundle first, including any files the restore will overwrite even if the current HTML no longer references them. Missing dependency files are restored to their missing state after preserving any newer local bytes; directories and other Lavish artifacts at those paths are left in place. Pausing backups never deletes existing copies.

If a backup fails, the library card and history drawer mark the latest content as not protected, show the error and the last successful backup date, and keep earlier copies available. The archive panel counts latest-protected, unprotected, and failed artifacts. Use **Retry backup** on the card or **Back up now** in the history drawer after fixing archive folder access.

If a source HTML file is deleted, its matching archive manifest keeps it in the library with its saved history. Restore recreates the HTML and archived assets in the existing source directory and resumes watching changes immediately. Recovery does not recreate a deleted project or source directory, and refuses symlinked source directories and destinations. With no current HTML there is no pre-restore source snapshot; archived assets replace the corresponding local assets. Opening, revealing, and manually backing up a source still require it to exist.

Dependencies are relative sibling/nested subresources inside the artifact folder: `src`/`srcset`, `href`/`xlink:href` (for example `<link>`, SVG `<image>` and `<use>`), CSS `url(...)`/`@import` references, and referenced directory contents. Navigation links (`<a>`/`<area>` `href`) are not dependencies. Parent-folder and absolute paths are excluded. HTTP, other remote schemes, and data URLs are not fetched and add no asset bytes to the checksum (their URL text remains part of the HTML/CSS bytes). Missing local assets are recorded as missing rather than failing the backup. Asset symlinks and paths through symlinked directories are recorded as excluded symlinks and never followed, even when their targets are inside the folder; restore refuses writes through a symlinked destination. Symlinked HTML sources cannot be archived or restored. Symlink targets and other unsupported filesystem entries are not restored.

New manifest entries use schema version 2 and retain the HTML checksum alongside the bundle checksum. Schema version 1 entries still read and restore: their bundle identity is derived from their archived files. Legacy restores preserve assets absent from the archive because version 1 did not record missing states. The next new snapshot upgrades the manifest header and appends an entry without changing old entries or archived bytes.

## Run it

Requires Node.js 22.13 or newer and the [`lavish-axi` CLI](https://github.com/kunchenguid/lavish-axi#session-hook). Install Lavish globally, then install this project's dependencies:

```bash
npm install -g lavish-axi
npm install
npm run dev
```

The app expects Lavish at `/opt/homebrew/bin/lavish-axi` by default. If `command -v lavish-axi` reports another location, pass it when starting the app:

```bash
LAVISH_AXI_BIN="$(command -v lavish-axi)" npm run dev
```

The library health check uses `LAVISH_AXI_PORT` (default `4387`), matching the port used by the CLI. When Lavish reports an installation identity (v0.1.78+), the library checks that it belongs to the configured state directory. The configured state directory remains `LAVISH_AXI_STATE_DIR` or `~/.lavish-axi`.

An available server does not confirm that an artifact rendered successfully. Cards with recorded fatal `artifact_failures` keep their review status (such as **Feedback waiting**) and add a separate **Review failed** badge with an expandable explanation. **Live** means an open session on an available server, not a successful render, so failed open sessions stay in **Live** with the badge. Ended reviews show no failure badge. These are the last diagnostics retained in Lavish's state; Lavish may clear them after delivering them to the agent. The library does not infer recovery from an HTTP health response. Older sessions without diagnostics add no warning.

Version history reads the agent's `script[data-lavish-revisions]` JSON registry from each saved HTML copy, showing its labels, timestamps and summaries as **Agent-declared revisions**. These declarations describe the agent's revision context; they are separate from the archive's measured size and line changes. Missing or malformed registries add nothing. **Reveal server.log** appears under the server indicator when the configured state directory contains that ordinary file, including while the server is unavailable.

Open [http://localhost:3000](http://localhost:3000). The library refreshes when the page loads and whenever you press the refresh button.

Library cards capture the artifact's first 1200 × 750 pixels locally using an installed Chrome or Chromium. No browser download is bundled: the small `puppeteer-core` driver uses Chrome on macOS or common Chromium/Chrome locations on Linux. Set `LAVISH_TRACKER_BROWSER` to the executable path for another installation. Without a working browser, cards show **Preview unavailable** and opening/history continue to work.

Captures run one at a time in the companion's background queue. PNGs are cached privately in the companion config directory (`~/.lavish-tracker/previews` by default), keyed by the HTML and bounded local dependency bundle. Refreshing the library or its 30-second reconciliation checks for edits, including CSS/image changes. Cards keep the earlier image marked **Updating preview…** until recapture finishes; a failed capture clears it to the fallback. Unchanged failures are retried after one minute on a later scan. Missing sources show **Source file missing**.

The capture browser uses a fresh temporary profile and receives only collected in-memory local bytes through request interception. Remote resources, parent-folder paths, asset symlinks, service workers, embedded frames, and network connections are blocked. Local inline/collected scripts can render the artifact; previews relying on remote resources or uncollected dynamic dependencies may look incomplete. The UI retrieves PNGs using the existing browser session token, addressed only by a known artifact ID.

To use another local UI port, set it explicitly for both services:

```bash
LAVISH_TRACKER_UI_PORT=3007 npm run dev
```

## Production-style local run

```bash
npm run build
npm start
```

By default, the web UI listens on `127.0.0.1:3000` and its filesystem companion service listens on `127.0.0.1:4318`. The default browser origins are `http://localhost:<UI port>` and `http://127.0.0.1:<UI port>`. The companion issues a fresh in-memory authorization token each time it starts and limits artifact operations to files discovered by the same bounded scan used to build the library. See [Optional private-network access](#optional-private-network-access) to configure access from other devices.

### Optional private-network access

To make both services reachable on a trusted private network, set `LAVISH_TRACKER_BIND_HOST` to the interface address or hostname to bind and set `LAVISH_TRACKER_ALLOWED_ORIGINS` to a comma-separated list of exact browser origins. An explicit allowlist replaces the default origins. Origins must include the scheme and port when one is used; paths, wildcards, and lists containing no origins are rejected. The companion accepts `Host` hostnames derived from those origins and the bind address. `LAVISH_TRACKER_UI_PORT` controls the UI port for both `npm run dev` and `npm start`; `LAVISH_TRACKER_API_PORT` controls the companion port. IPv6 bind addresses may be bracketed or unbracketed; URLs must use brackets, and binding to `::1` also adds `http://[::1]:<UI port>` to the default origins. Set `LAVISH_TRACKER_API_BASE` to the reachable IPv6 companion URL when using an IPv6-only bind.

Both launch commands load settings from the project root before starting either service. Shell environment values take precedence, followed by `.env.<mode>.local`, `.env.local`, `.env.<mode>`, and `.env`, where `<mode>` is `development` for `npm run dev` and `production` for `npm start`. A shared `.env.local` can hold the bind host, origins, ports, and API base; these files are ignored by Git.

For example, serve the UI and companion through separate HTTPS ports on a private-network hostname:

```bash
LAVISH_TRACKER_BIND_HOST=0.0.0.0 \
LAVISH_TRACKER_ALLOWED_ORIGINS=https://library.example.com \
LAVISH_TRACKER_API_BASE=https://library.example.com:8443 \
npm run dev
```

Configure the HTTPS front to forward the UI port to the app and its separate companion port to the configured filesystem service port, preserving the hostname in `Host`. The companion's HTTPS port serves `/api/*` directly. `LAVISH_TRACKER_API_BASE` must be an absolute HTTP(S) URL reachable by the browser; relative API paths are unsupported. For direct private-network access, use the UI's exact origin and the companion's reachable URL. Changing the companion port also requires updating the API base, whose default remains `http://127.0.0.1:4318`. `LAVISH_TRACKER_API_BASE` is compiled into the UI, so set it while running `npm run build`. Supply the bind host, allowed origins, and any configured ports when starting a production build; changing the API base at startup requires rebuilding the UI.

Binding to a non-loopback address without an explicit origin allowlist is refused at startup. Private-network reachability and the explicit origin allowlist are the trust boundary: there are no accounts or identity authentication. Any peer that can reach the companion and supply an allowed origin can obtain a token and read or modify the owner's discovered library, including restoring archived files. Use private-network access controls to limit reachable peers and HTTPS to protect data in transit. Non-allowlisted origins are rejected. In remote mode, every API read and mutation requires the per-start token even without browser headers; session bootstrap requires an allowed origin, and CORS preflight does not require a token. Header-free command-line clients connected over loopback can omit the token only when the companion is also bound to loopback.

Files, archives, and native actions remain on the host Mac. Folder pickers, Finder reveals, and opening live or archived reviews execute there. Pasted project paths refer to folders on that Mac. This option exposes the library UI and companion; the Lavish review server retains its separate local configuration.

## License

[MIT](LICENSE) © 2026 Jarad Smith

## Development checks and CI

Run `npm test`, `npm run lint`, `npm run typecheck`, and `npm run build`. Session reply counts measure retained agent replies; reviewer messages still contribute to last-used timestamps. Upstream bounds retained chat, so these counts are not lifetime totals.

Run `npm run test:backup-ui` with `chrome-devtools-axi` installed to exercise backup warnings, keyboard retry, last-success dates, and summary recovery in an isolated browser against synthetic data. This opt-in check does not use an installed Lavish library. Set `LAVISH_BACKUP_SCREENSHOT_DIR` to a local output folder to capture desktop and mobile warning layouts.

CI runs tests, lint, type checks, and the production build on GitHub-hosted Ubuntu runners for main pushes and pull requests. Release Please also uses a GitHub-hosted runner.
