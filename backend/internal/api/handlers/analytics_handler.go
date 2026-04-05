package handlers

import (
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

func (h *Handler) AnalyticsSummary(c *fiber.Ctx) error {
	return c.JSON(models.OK(map[string]interface{}{
		"runsToday":               268,
		"avgLatencyMs":            1800,
		"tokenCostUsd":            295,
		"projectedMonthlyCostUsd": 1180,
		"successRate":             98.4,
		"healingSuccessRate":      86,
		"validationF1Score":       0.94,
	}, "OK", map[string]interface{}{"range": c.Query("range", "7d")}))
}

func (h *Handler) AnalyticsPerformance(c *fiber.Ctx) error {
	return c.JSON(models.OK(series(func(label string, index int) map[string]interface{} {
		return map[string]interface{}{"label": label, "runs": 160 + index*18, "successRate": 97.1 + float64(index)/5, "avgLatencyMs": 1900 - index*40, "p95LatencyMs": 3100 - index*55}
	}), "OK", map[string]interface{}{"interval": c.Query("interval", "day")}))
}

func (h *Handler) AnalyticsUsage(c *fiber.Ctx) error {
	return c.JSON(models.OK(series(func(label string, index int) map[string]interface{} {
		input := 240000 + index*18000
		output := 120000 + index*12000
		return map[string]interface{}{"label": label, "inputTokens": input, "outputTokens": output, "totalTokens": input + output, "costUsd": 42 + index*4}
	}), "OK", map[string]interface{}{"currency": "USD"}))
}

func (h *Handler) AnalyticsSelfHealing(c *fiber.Ctx) error {
	return c.JSON(models.OK(map[string]interface{}{
		"successRate": 86, "attempts": 38, "recovered": 33, "failed": 5,
		"byReason": []map[string]interface{}{{"reason": "connector_token_expired", "attempts": 12, "recovered": 12}, {"reason": "schema_drift", "attempts": 9, "recovered": 7}},
	}, "OK", nil))
}

func (h *Handler) AnalyticsLatency(c *fiber.Ctx) error {
	return c.JSON(models.OK([]map[string]interface{}{
		{"bucket": "0-500ms", "count": 21},
		{"bucket": "500ms-1s", "count": 78},
		{"bucket": "1s-2s", "count": 140},
		{"bucket": "2s-5s", "count": 29},
	}, "OK", nil))
}

func (h *Handler) AnalyticsF1Score(c *fiber.Ctx) error {
	return c.JSON(models.OK(map[string]interface{}{"score": 0.94, "precision": 0.96, "recall": 0.92, "samples": 240, "falsePositives": 5, "falseNegatives": 7}, "OK", nil))
}

func (h *Handler) AnalyticsActivityHeatmap(c *fiber.Ctx) error {
	today := time.Now().UTC()
	data := []map[string]interface{}{}
	for i := 13; i >= 0; i-- {
		date := today.AddDate(0, 0, -i)
		data = append(data, map[string]interface{}{"date": date.Format("2006-01-02"), "count": 80 + i*9, "intensity": 0.35 + float64(14-i)/20})
	}
	return c.JSON(models.OK(data, "OK", map[string]interface{}{"timezone": c.Query("timezone", "Asia/Colombo")}))
}

func (h *Handler) AnalyticsCostTrends(c *fiber.Ctx) error {
	return c.JSON(models.OK(series(func(label string, index int) map[string]interface{} {
		return map[string]interface{}{"label": label, "costUsd": 42 + index*4, "projectedUsd": 48 + index*5}
	}), "OK", map[string]interface{}{"interval": c.Query("interval", "day")}))
}

func series(build func(label string, index int) map[string]interface{}) []map[string]interface{} {
	labels := []string{"Mon", "Tue", "Wed", "Thu", "Fri", "Sat"}
	out := make([]map[string]interface{}, 0, len(labels))
	for index, label := range labels {
		out = append(out, build(label, index))
	}
	return out
}
