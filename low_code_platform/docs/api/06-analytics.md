# Analytics API

Base path: `/api/analytics`

## Endpoints

| Method | Endpoint | Auth | Query Params | Success Response |
|---|---|---|---|---|
| `GET` | `/analytics/summary` | Required | `range`, `workflowId` | `AnalyticsSummary` |
| `GET` | `/analytics/performance` | Required | `range`, `workflowId`, `interval` | `PerformanceSeries` |
| `GET` | `/analytics/usage` | Required | `range`, `workflowId`, `interval` | `UsageSeries` |
| `GET` | `/analytics/self-healing` | Required | `range`, `workflowId` | `HealingAnalytics` |
| `GET` | `/analytics/latency` | Required | `range`, `workflowId` | `LatencyHistogram` |
| `GET` | `/analytics/f1-score` | Required | `range`, `workflowId` | `F1ScoreAnalytics` |
| `GET` | `/analytics/activity-heatmap` | Required | `range`, `timezone` | `ActivityHeatmap` |
| `GET` | `/analytics/cost-trends` | Required | `range`, `interval` | `CostTrendSeries` |

## Summary Response

```json
{
  "success": true,
  "data": {
    "runsToday": 268,
    "avgLatencyMs": 1800,
    "tokenCostUsd": 295,
    "projectedMonthlyCostUsd": 1180,
    "successRate": 98.4,
    "healingSuccessRate": 86,
    "validationF1Score": 0.94
  },
  "message": "OK",
  "meta": {
    "range": "7d"
  }
}
```

## Performance Response

```json
{
  "success": true,
  "data": [
    {
      "label": "Mon",
      "runs": 160,
      "successRate": 97.1,
      "avgLatencyMs": 1900,
      "p95LatencyMs": 3100
    }
  ],
  "message": "OK",
  "meta": {
    "interval": "day"
  }
}
```

## Usage Response

```json
{
  "success": true,
  "data": [
    {
      "label": "Mon",
      "inputTokens": 240000,
      "outputTokens": 120000,
      "totalTokens": 360000,
      "costUsd": 42
    }
  ],
  "message": "OK",
  "meta": {
    "currency": "USD"
  }
}
```

## Self-Healing Response

```json
{
  "success": true,
  "data": {
    "successRate": 86,
    "attempts": 38,
    "recovered": 33,
    "failed": 5,
    "byReason": [
      {
        "reason": "connector_token_expired",
        "attempts": 12,
        "recovered": 12
      }
    ]
  },
  "message": "OK",
  "meta": null
}
```

## Heatmap Response

```json
{
  "success": true,
  "data": [
    {
      "date": "2026-05-02",
      "count": 268,
      "intensity": 0.82
    }
  ],
  "message": "OK",
  "meta": {
    "timezone": "Asia/Colombo"
  }
}
```

