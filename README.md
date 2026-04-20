# Eidos Backend Service

Express backend for Instagram scraping, post classification, and insight generation.

## Deploy Target

This repo is ready for Northflank deployments using Heroku-style buildpacks (no Docker required).

## Runtime Requirements

- Node.js 18+
- Environment variable `OPENROUTER_API_KEY`

Optional environment variables:

- `PORT` (default: `3000`)
- `OPENROUTER_MODEL` (default: `google/gemma-4-26b-a4b-it`)
- `DEFAULT_ACCOUNTS` (comma-separated handles, default: `plaeto.schools`)
- `DEFAULT_MAX_POSTS` (default: `2`)
- `STORAGE_STATE_BASE64` (base64-encoded Playwright storage state JSON; highest priority)
- `STORAGE_STATE_JSON` (raw Playwright storage state JSON string; second priority)
- `STORAGE_STATE_PATH` (default: `state.json`; used only if env state is not provided)

## Start

```bash
npm install
npm start
```

The process binds to `PORT`, which Northflank sets automatically.

## API Routes

### `GET /`
Service info and route list.

### `GET /health`
Basic liveness response.

### `GET /api/categories`
Returns supported intent and format categories.

### `POST /api/classify`
Classifies a single caption with optional image context.

Request body:

```json
{
  "caption": "A sample Instagram caption",
  "imageUrl": "https://example.com/image.jpg",
  "categories": {
    "intent": ["Promotional", "Educational"],
    "format": ["Trend", "Tutorial"]
  }
}
```

Notes:
- `categories` is optional. If not provided, the default categories are used.

### `POST /api/analyze`
Runs end-to-end scrape + classify + analytics.

Request body:

```json
{
  "accounts": ["plaeto.schools", "another.brand"],
  "maxPosts": 3,
  "includeAiOverview": true,
  "generateExcel": true,
  "categories": {
    "intent": ["Promotional", "Educational"],
    "format": ["Trend", "Tutorial"]
  }
}
```

Notes:

- `accounts` is optional; falls back to `DEFAULT_ACCOUNTS`.
- `maxPosts` must be between 1 and 25.
- `categories` is optional; falls back to default categories if not provided.
- One analysis run is allowed at a time.

### `GET /api/runs/latest`
Returns the latest completed analysis payload.

### `GET /api/runs/latest/excel`
Downloads the latest generated Excel file (if `generateExcel` was true).

## Northflank Setup Notes

- Build command: `npm install`
- Start command: `npm start`
- Heroku buildpack mode will also detect the included `Procfile` (`web: npm start`).

## Security Notes

- Keep `.env` and `state.json` private.
- `state.json` includes authenticated browser session state; do not commit it.

### Storing State In Env

To move browser auth state from `state.json` into an environment variable, prefer base64:

```bash
node -e "process.stdout.write(Buffer.from(require('fs').readFileSync('state.json','utf8')).toString('base64'))"
```

Set that output as `STORAGE_STATE_BASE64` in your deployment environment.
