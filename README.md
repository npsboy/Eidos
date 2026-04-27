# Eidos Backend Service

Express backend for Instagram scraping via Apify, post classification, and insight generation.

## Deploy Target

This repo is configured for Docker-based deployment.

## Runtime Requirements

- Node.js 18+
- Environment variable `OPENROUTER_API_KEY`
- Environment variable `APIFY_TOKEN`

Optional environment variables:

- `PORT` (default: `3000`)
- `OPENROUTER_MODEL` (default: `google/gemma-4-26b-a4b-it`)
- `DEFAULT_ACCOUNTS` (comma-separated handles, default: `plaeto.schools`)
- `DEFAULT_MAX_POSTS` (default: `2`)
- `APIFY_INSTAGRAM_ACTOR` (default: `apify/instagram-post-scraper`)

## Start

```bash
npm install
npm start
```

The process binds to `PORT`, which your platform should set automatically.

## Docker Deploy

Use the included `Dockerfile` as the runtime source.

```bash
docker build -t eidos-backend .
docker run -p 3000:3000 --env-file .env eidos-backend
```

Important:
- Runtime command must be `npm start` (or `node index.js`).
- Do not use `node test_analyze.js` as the service start command; it is only a one-off client test script.

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

- Build method: Dockerfile
- Runtime command (inside container): `npm start`
- Container port: `3000`

## Security Notes

- Keep `.env` private.
- Do not commit API keys such as `OPENROUTER_API_KEY` or `APIFY_TOKEN`.
