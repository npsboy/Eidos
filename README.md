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
- `STORAGE_STATE_PATH` (default: `state.json`)

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
  "imageUrl": "https://example.com/image.jpg"
}
```

### `POST /api/analyze`
Runs end-to-end scrape + classify + analytics.

Request body:

```json
{
  "accounts": ["plaeto.schools", "another.brand"],
  "maxPosts": 3,
  "includeAiOverview": true,
  "generateExcel": true
}
```

Notes:

- `accounts` is optional; falls back to `DEFAULT_ACCOUNTS`.
- `maxPosts` must be between 1 and 25.
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
