package unit

import (
	"encoding/json"
	"fmt"
	"html"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type accuracyDashboardSpec struct {
	Title       string
	ReportJSON  string
	ReportHTML  string
	MetricNames []string
	Charts      []accuracyDashboardChart
}

type accuracyDashboardChart struct {
	Title string
	File  string
}

func writeAccuracyDashboard(t *testing.T, reportDir string) {
	t.Helper()
	specs := []accuracyDashboardSpec{
		{
			Title:       "Fixture Validator Cases",
			ReportJSON:  "validator_accuracy_report.json",
			ReportHTML:  "validator_accuracy_report.html",
			MetricNames: []string{"total", "accuracy", "precision", "recall", "specificity", "f1_score", "mcc", "true_pass", "true_block", "false_pass", "false_block"},
			Charts: []accuracyDashboardChart{
				{Title: "Metrics", File: "validator_accuracy_metrics.svg"},
				{Title: "Confusion Matrix", File: "validator_accuracy_confusion_matrix.svg"},
			},
		},
		{
			Title:       "Generated Validator 5000 Long Flows",
			ReportJSON:  "validator_generated_5000_report.json",
			ReportHTML:  "validator_generated_5000_report.html",
			MetricNames: []string{"total", "accuracy", "precision", "recall", "specificity", "f1_score", "mcc", "true_pass", "true_block", "false_pass", "false_block"},
			Charts: []accuracyDashboardChart{
				{Title: "Metrics", File: "validator_generated_5000_metrics.svg"},
				{Title: "Confusion Matrix", File: "validator_generated_5000_confusion_matrix.svg"},
			},
		},
		{
			Title:       "Semantic Search 5000 Queries",
			ReportJSON:  "semantic_search_accuracy_report.json",
			ReportHTML:  "semantic_search_accuracy_report.html",
			MetricNames: []string{"total", "accuracy", "tool_set_recall", "rule_set_recall", "top1_tool_accuracy", "mean_reciprocal_rank", "loaded_tool_count", "loaded_rule_count", "fully_correct", "tool_all_hit", "rule_all_hit"},
			Charts: []accuracyDashboardChart{
				{Title: "Retrieval Metrics", File: "semantic_search_accuracy_metrics.svg"},
			},
		},
		{
			Title:       "Mock Gemini Generation 5000 Long Flows",
			ReportJSON:  "gemini_generation_5000_report.json",
			ReportHTML:  "gemini_generation_5000_report.html",
			MetricNames: []string{"total", "accuracy", "precision", "recall", "specificity", "f1_score", "mcc", "true_pass", "true_block", "false_pass", "false_block"},
			Charts: []accuracyDashboardChart{
				{Title: "Metrics", File: "gemini_generation_5000_metrics.svg"},
				{Title: "Confusion Matrix", File: "gemini_generation_5000_confusion_matrix.svg"},
			},
		},
		{
			Title:       "Live Gemini API Generation",
			ReportJSON:  "gemini_live_api_report.json",
			ReportHTML:  "gemini_live_api_report.html",
			MetricNames: []string{"total", "accuracy", "precision", "recall", "specificity", "f1_score", "mcc", "true_pass", "true_block", "false_pass", "false_block"},
			Charts: []accuracyDashboardChart{
				{Title: "Metrics", File: "gemini_live_api_metrics.svg"},
				{Title: "Confusion Matrix", File: "gemini_live_api_confusion_matrix.svg"},
			},
		},
	}

	if err := os.MkdirAll(reportDir, 0o755); err != nil {
		t.Fatalf("create accuracy dashboard directory: %v", err)
	}

	var cards strings.Builder
	var rows strings.Builder
	var chartSections strings.Builder
	for _, spec := range specs {
		metrics, outcomes, ok := readDashboardReport(filepath.Join(reportDir, spec.ReportJSON))
		status := "NOT RUN"
		statusClass := "pending"
		if ok {
			status = "PASS"
			statusClass = "pass"
		}

		accuracy := dashboardMetric(metrics, "accuracy")
		if ok {
			fmt.Fprintf(&cards, `<div class="card %s"><span>%s</span><strong>%s</strong><em>%s cases</em></div>`,
				statusClass,
				html.EscapeString(spec.Title),
				formatDashboardMetric(accuracy),
				formatDashboardMetric(dashboardMetric(metrics, "total")),
			)
		} else {
			fmt.Fprintf(&cards, `<div class="card %s"><span>%s</span><strong>%s</strong><em>Run tests to generate</em></div>`,
				statusClass,
				html.EscapeString(spec.Title),
				status,
			)
		}

		fmt.Fprintf(&rows, `<tr class="%s"><td>%s</td><td>%s</td><td>%d</td>`, statusClass, html.EscapeString(spec.Title), status, outcomes)
		for _, metricName := range spec.MetricNames {
			rows.WriteString("<td>")
			rows.WriteString(formatDashboardMetric(dashboardMetric(metrics, metricName)))
			rows.WriteString("</td>")
		}
		fmt.Fprintf(&rows, `<td><a href="%s">open report</a></td></tr>`, html.EscapeString(spec.ReportHTML))

		fmt.Fprintf(&chartSections, `<section class="report-section"><div class="section-head"><h2>%s</h2><a href="%s">Detailed report</a></div><div class="chart-grid">`,
			html.EscapeString(spec.Title),
			html.EscapeString(spec.ReportHTML),
		)
		for _, chart := range spec.Charts {
			if _, err := os.Stat(filepath.Join(reportDir, chart.File)); err != nil {
				fmt.Fprintf(&chartSections, `<div class="chart missing"><strong>%s</strong><p>Chart will appear after its test report is generated.</p></div>`, html.EscapeString(chart.Title))
				continue
			}
			fmt.Fprintf(&chartSections, `<div class="chart"><strong>%s</strong><img src="%s" alt="%s"></div>`,
				html.EscapeString(chart.Title),
				html.EscapeString(chart.File),
				html.EscapeString(spec.Title+" "+chart.Title),
			)
		}
		chartSections.WriteString(`</div></section>`)
	}

	writeReportFile(t, filepath.Join(reportDir, "all_test_values_report.html"), fmt.Sprintf(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>All Test Values Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 28px; color: #111827; background: #f8fafc; }
    h1 { margin-bottom: 4px; }
    p { color: #4b5563; }
    .cards { display: grid; grid-template-columns: repeat(4, minmax(180px, 1fr)); gap: 12px; margin: 24px 0; }
    .card { background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px; }
    .card span, .card em { display: block; color: #4b5563; font-style: normal; font-size: 13px; }
    .card strong { display: block; margin: 8px 0; font-size: 28px; }
    .card.pass strong { color: #15803d; }
    .card.pending strong { color: #92400e; }
    table { width: 100%%; border-collapse: collapse; background: white; border: 1px solid #e5e7eb; }
    th, td { text-align: left; padding: 9px; border-bottom: 1px solid #e5e7eb; vertical-align: top; font-size: 13px; white-space: nowrap; }
    th { background: #f3f4f6; }
    tr.pending { background: #fffbeb; }
    a { color: #2563eb; text-decoration: none; }
    .report-section { margin: 26px 0; }
    .section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
    h2 { margin: 0 0 12px; font-size: 20px; }
    .chart-grid { display: grid; grid-template-columns: repeat(2, minmax(280px, 1fr)); gap: 14px; }
    .chart { background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; overflow: auto; }
    .chart strong { display: block; margin-bottom: 8px; }
    .chart img { display: block; width: 100%%; max-height: 380px; object-fit: contain; }
    .chart.missing { color: #92400e; background: #fffbeb; }
  </style>
</head>
<body>
  <h1>All Test Values Report</h1>
  <p>Consolidated metrics from validator, semantic search, mock Gemini, and optional live Gemini API tests.</p>
  <section class="cards">%s</section>
  %s
  <table>
    <thead>
      <tr>
        <th>Test Report</th><th>Status</th><th>Outcomes</th>
        <th>Total</th><th>Accuracy</th><th>Precision / Tool Recall</th><th>Recall / Rule Recall</th><th>Specificity / Top1</th><th>F1 / MRR</th><th>MCC / Correct</th><th>TP / Tool Hit</th><th>TB / Rule Hit</th><th>FP</th><th>FB</th><th>Link</th>
      </tr>
    </thead>
    <tbody>%s</tbody>
  </table>
</body>
</html>`, cards.String(), chartSections.String(), rows.String()))
}

func readDashboardReport(path string) (map[string]interface{}, int, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return map[string]interface{}{}, 0, false
	}
	var payload struct {
		Metrics  map[string]interface{} `json:"metrics"`
		Outcomes []json.RawMessage      `json:"outcomes"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return map[string]interface{}{}, 0, false
	}
	return payload.Metrics, len(payload.Outcomes), true
}

func dashboardMetric(metrics map[string]interface{}, name string) interface{} {
	if value, ok := metrics[name]; ok {
		return value
	}
	return nil
}

func formatDashboardMetric(value interface{}) string {
	switch typed := value.(type) {
	case nil:
		return "-"
	case float64:
		if typed == float64(int64(typed)) {
			return fmt.Sprintf("%.0f", typed)
		}
		return fmt.Sprintf("%.3f", typed)
	case int:
		return fmt.Sprintf("%d", typed)
	case int64:
		return fmt.Sprintf("%d", typed)
	case string:
		return html.EscapeString(typed)
	default:
		return html.EscapeString(fmt.Sprint(typed))
	}
}
