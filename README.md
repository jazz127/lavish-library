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

All project paths and preferences stay on the Mac in `~/.lavish-tracker/config.json`. Nothing is uploaded by the app.

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
