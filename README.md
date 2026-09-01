# Lavish Library

A private, local-first browser library for finding and reopening Lavish review surfaces on a Mac.

## What it does

- Reads Lavish's central session history from `~/.lavish-axi/state.json`
- Automatically groups known artifacts by project
- Finds additional HTML artifacts in project `.lavish` folders
- Shows session state, server availability, last-used time, edit time, and file size
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

The app distinguishes recorded evidence from unknown history. It can backfill file dates, known Lavish sessions, protected versions, and local Git commits; searches and library interactions begin recording with v0.2.

## Versions

- `v0.1.0` — local Lavish library and protected version archive
- `v0.2.0` — Signal Observatory, Lavish Review, feedback, recommendations, and plan evolution

## Version archive

Choose **Set up archive** in the app and select any local or synced folder. The app creates a readable `Lavish Library Archive` beneath it, grouped by project and artifact. Each version has its own HTML file, local assets, checksum, timestamps, and manifest entry.

The first scan creates a baseline. While the app is running, watched files are backed up shortly after each saved change; a 30-second reconciliation scan catches new artifacts and anything a watcher missed. Restoring an older version always archives the current file first. Pausing backups never deletes existing copies.

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

Open [http://localhost:3000](http://localhost:3000). The library refreshes when the page loads and whenever you press the refresh button.

To use another local UI port, set it explicitly for both services:

```bash
LAVISH_TRACKER_UI_PORT=3007 npm run dev
```

## Production-style local run

```bash
npm run build
npm start
```

The web UI listens on localhost and its filesystem companion service listens on `127.0.0.1:4318`. The companion service accepts browser requests only from `localhost` or `127.0.0.1` on the configured UI port, issues a fresh in-memory authorization token each time it starts, and limits artifact operations to files discovered by the same bounded scan used to build the library.

## License

[MIT](LICENSE) © 2026 Jarad Smith
