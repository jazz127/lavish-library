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

All project paths and preferences stay on the Mac in `~/.lavish-tracker/config.json`. Nothing is uploaded by the app.

## Version archive

Choose **Set up archive** in the app and select any local or synced folder. The app creates a readable `Lavish Library Archive` beneath it, grouped by project and artifact. Each version has its own HTML file, local assets, checksum, timestamps, and manifest entry.

The first scan creates a baseline. While the app is running, watched files are backed up shortly after each saved change; a 30-second reconciliation scan catches new artifacts and anything a watcher missed. Restoring an older version always archives the current file first. Pausing backups never deletes existing copies.

## Run it

Requires Node.js 22.13 or newer and `lavish-axi` installed at `/opt/homebrew/bin/lavish-axi`.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The library refreshes when the page loads and whenever you press the refresh button.

## Production-style local run

```bash
npm run build
npm start
```

The web UI listens on localhost and its filesystem companion service listens on `127.0.0.1:4318`. The companion service only accepts browser requests from local origins.
