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

Response body:

```json
{
  "classification": {
    "intent": "Promotional",
    "format": "Trend"
  },
  "rawResponse": "{\n  \"intent\": \"Promotional\",\n  \"format\": \"Trend\"\n}"
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

Response body:

```json
{
  "runId": "1713600000000",
  "createdAt": "2026-04-20T12:00:00.000Z",
  "accounts": [
    "plaeto.schools",
    "another.brand"
  ],
  "maxPosts": 3,
  "rawData": {
    "plaeto.schools": [
      {
        "link": "https://www.instagram.com/p/...",
        "img": "https://...",
        "type": "post",
        "likes": 1500,
        "comments": 45,
        "caption": "Example caption...",
        "date": "2026-04-18T10:00:00.000Z",
        "intent": "Educational",
        "format": "Tutorial"
      }
    ],
    "another.brand": []
  },
  "analysis": {
    "global_insights": {
      "intent_insights": {
        "Educational": {
          "global_relative_performance_average": {
            "likes": "10.50%",
            "comments": "5.00%"
          },
          "global_relative_performance_median": {
            "likes": "8.00%",
            "comments": "2.50%"
          },
          "account_relative_win_rate": {
            "likes": "50.00%",
            "comments": "25.00%"
          }
        }
      },
      "format_insights": {
        "Tutorial": {
          "global_relative_performance_average": {
            "likes": "15.00%",
            "comments": "N/A"
          },
          "global_relative_performance_median": {
            "likes": "12.00%",
            "comments": "N/A"
          },
          "account_relative_win_rate": {
            "likes": "100.00%",
            "comments": "0.00%"
          }
        }
      }
    },
    "additional_insights": {
      "topPerformer": {
        "account": "plaeto.schools",
        "frequency": "2 days"
      },
      "reelsPerformanceOverPosts": "15.20%",
      "timeOfDayEngagement": {
        "10:00 to 12:00": {
          "avgLikes": 1500,
          "avgComments": 45
        }
      }
    },
    "account_analysis": {
      "plaeto.schools": {
        "averageLikesComments": {
          "avgLikes": 1500,
          "avgComments": 45
        },
        "totalPosts": 3,
        "intentDistribution": {
          "Educational": {
            "no_of_posts": 1,
            "category_total_likes": 1500,
            "category_total_comments": 45,
            "category_avg_likes": 1500,
            "category_avg_comments": 45,
            "relative_performance": {
              "likes": "0.00%",
              "comments": "0.00%"
            }
          }
        },
        "formatDistribution": {
          "Tutorial": {
            "no_of_posts": 1,
            "category_total_likes": 1500,
            "category_total_comments": 45,
            "category_avg_likes": 1500,
            "category_avg_comments": 45,
            "relative_performance": {
              "likes": "0.00%",
              "comments": "0.00%"
            }
          }
        },
        "averageTimeBetweenPostsReadable": "2 days"
      }
    }
  },
  "aiOverview": null,
  "excelPath": ".../outputs/global_insights_1713600000000.xlsx",
  "errors": []
}
```

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
