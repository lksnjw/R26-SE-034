package orchestrator

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/semanticsearch"
)

const terminalReportWidth = 118

var terminalSecretPattern = regexp.MustCompile(`(?i)(api[_-]?key|token|password|secret|authorization|auth[_-]?header|private[_-]?key)\s*[:=]\s*\S+`)

func RenderTerminalTrace(req ChatRequest, resp ChatResponse, elapsed time.Duration) string {
	var out strings.Builder
	out.WriteString(box("Chat Workflow Pipeline", []string{
		fmt.Sprintf("session: %s    role: %s    mode: %s    model: %s    duration: %s",
			blank(req.SessionID, "unknown"),
			blank(req.UserRole, "anonymous"),
			blank(req.Mode, "generate_workflow"),
			blank(req.Model, "configured-default"),
			elapsed.Round(time.Millisecond),
		),
		"request: " + compact(redactTerminalText(req.UserText), 180),
	}))

	out.WriteString(box("Semantic Search Results", semanticLines(resp.Retrieval)))
	out.WriteString(box("Generation And Validation", validationLines(resp)))

	if strings.TrimSpace(resp.SelectedWorkflowYAML) != "" {
		out.WriteString(box("Selected Workflow YAML", selectedWorkflowLines(resp)))
	}
	if len(resp.BlockingErrors) > 0 && !resp.CanExecute {
		out.WriteString(box("Blocking Errors", errorLines(resp.BlockingErrors, 10)))
	}
	return out.String()
}

func RenderTerminalError(req ChatRequest, elapsed time.Duration, err error) string {
	errText := ""
	if err != nil {
		errText = err.Error()
	}
	return box("Chat Workflow Pipeline Failed", []string{
		fmt.Sprintf("session: %s    role: %s    mode: %s    duration: %s",
			blank(req.SessionID, "unknown"),
			blank(req.UserRole, "anonymous"),
			blank(req.Mode, "generate_workflow"),
			elapsed.Round(time.Millisecond),
		),
		"request: " + compact(redactTerminalText(req.UserText), 180),
		"error: " + compact(redactTerminalText(errText), 220),
	})
}

func semanticLines(result semanticsearch.Result) []string {
	lines := []string{
		"method: " + blank(firstNonEmpty(result.RetrievalMethod, result.Method), "unknown"),
		fmt.Sprintf("retrieved: tools=%d rules=%d global_rules=%d templates=%d examples=%d",
			len(result.Tools), len(result.Rules), len(result.GlobalRules), len(result.Templates), len(result.Examples)),
		"",
		"Top tools:",
	}
	if len(result.Tools) == 0 {
		lines = append(lines, "  no tools retrieved")
	} else {
		for index, tool := range result.Tools {
			if index == 8 {
				lines = append(lines, fmt.Sprintf("  ... %d more tools", len(result.Tools)-index))
				break
			}
			status := blank(tool.Status, "active_mcp_schema_present")
			lines = append(lines, fmt.Sprintf("  %2d. %.3f  %s  [%s]  %s",
				index+1, tool.Score, blank(tool.Name, tool.ToolID), blank(tool.Module, "module?"), status))
			if strings.TrimSpace(tool.MatchReason) != "" {
				lines = append(lines, "      "+compact(tool.MatchReason, 120))
			}
		}
	}

	lines = append(lines, "", "Top rules:")
	if len(result.Rules) == 0 {
		lines = append(lines, "  no domain rules retrieved")
	} else {
		for index, rule := range result.Rules {
			if index == 8 {
				lines = append(lines, fmt.Sprintf("  ... %d more rules", len(result.Rules)-index))
				break
			}
			lines = append(lines, fmt.Sprintf("  %2d. %.3f  %s  [%s/%s]",
				index+1, rule.Score, blank(rule.RuleID, rule.RuleName), blank(rule.Domain, "domain?"), blank(rule.RuleType, "rule")))
			if strings.TrimSpace(rule.MatchReason) != "" {
				lines = append(lines, "      "+compact(rule.MatchReason, 120))
			}
		}
	}

	if len(result.GlobalRules) > 0 {
		lines = append(lines, "", "Global guardrails:")
		for index, rule := range result.GlobalRules {
			if index == 6 {
				lines = append(lines, fmt.Sprintf("  ... %d more global rules", len(result.GlobalRules)-index))
				break
			}
			lines = append(lines, fmt.Sprintf("  %2d. %.3f  %s", index+1, rule.Score, blank(rule.RuleID, rule.RuleName)))
		}
	}
	return lines
}

func validationLines(resp ChatResponse) []string {
	canExecute := "NO"
	if resp.CanExecute {
		canExecute = "YES"
	}
	lines := []string{
		fmt.Sprintf("candidates=%d    passed=%d    blocked=%d    best_score=%.2f    can_execute=%s",
			len(resp.Candidates),
			resp.ValidationSummary.PassedCandidates,
			resp.ValidationSummary.BlockedCandidates,
			resp.ValidationSummary.BestScore,
			canExecute,
		),
		"assistant: " + compact(resp.AssistantMessage, 180),
	}
	if resp.SelectedCandidateID != "" {
		lines = append(lines, "selected_candidate: "+resp.SelectedCandidateID)
	}
	if resp.NextAction != "" {
		lines = append(lines, "next_action: "+resp.NextAction)
	}

	lines = append(lines, "", "Candidate checks:")
	if len(resp.Candidates) == 0 {
		lines = append(lines, "  no candidates generated")
		return lines
	}
	for index, report := range resp.Candidates {
		if index == 8 {
			lines = append(lines, fmt.Sprintf("  ... %d more candidates", len(resp.Candidates)-index))
			break
		}
		status := "BLOCK"
		if report.Validation.Passed {
			status = "PASS"
		}
		selected := ""
		if report.CandidateID == resp.SelectedCandidateID {
			selected = "  selected"
		}
		fallback := ""
		if isFallback(report.Generation) {
			fallback = "  fallback"
		}
		lines = append(lines, fmt.Sprintf("  %s  %s  score=%.2f risk=%s steps=%d%s%s",
			status,
			report.CandidateID,
			report.Validation.Score,
			blank(report.Validation.EstimatedRisk, "unknown"),
			report.Validation.StepCount,
			selected,
			fallback,
		))
		if len(report.Validation.FailedRules) > 0 {
			lines = append(lines, "      failed_rules: "+compact(strings.Join(report.Validation.FailedRules, ", "), 120))
		}
		for _, errText := range limited(report.Validation.Errors, 2) {
			lines = append(lines, "      error: "+compact(redactTerminalText(errText), 150))
		}
	}
	return lines
}

func selectedWorkflowLines(resp ChatResponse) []string {
	lines := []string{"candidate: " + resp.SelectedCandidateID, ""}
	rawLines := strings.Split(strings.TrimSpace(resp.SelectedWorkflowYAML), "\n")
	for index, line := range rawLines {
		if index == 42 {
			lines = append(lines, fmt.Sprintf("... %d more YAML lines", len(rawLines)-index))
			break
		}
		lines = append(lines, redactTerminalText(line))
	}
	return lines
}

func errorLines(errors []string, max int) []string {
	lines := []string{}
	for index, errText := range errors {
		if index == max {
			lines = append(lines, fmt.Sprintf("... %d more errors", len(errors)-index))
			break
		}
		lines = append(lines, fmt.Sprintf("%2d. %s", index+1, compact(redactTerminalText(errText), 190)))
	}
	return lines
}

func box(title string, lines []string) string {
	innerWidth := terminalReportWidth - 4
	var b strings.Builder
	b.WriteString(boxBorder(title, "="))
	for _, line := range lines {
		for _, wrapped := range wrapTerminalLine(line, innerWidth) {
			b.WriteString("| ")
			b.WriteString(rightPad(wrapped, innerWidth))
			b.WriteString(" |\n")
		}
	}
	b.WriteString(boxBorder("", "-"))
	b.WriteString("\n")
	return b.String()
}

func boxBorder(title, fill string) string {
	if title == "" {
		return "+" + strings.Repeat(fill, terminalReportWidth-2) + "+\n"
	}
	label := " " + strings.ToUpper(title) + " "
	available := terminalReportWidth - 2
	if len(label) >= available {
		return "+" + label[:available] + "+\n"
	}
	return "+" + label + strings.Repeat(fill, available-len(label)) + "+\n"
}

func wrapTerminalLine(line string, width int) []string {
	line = strings.ReplaceAll(line, "\t", "  ")
	line = strings.TrimRight(line, " ")
	if line == "" {
		return []string{""}
	}
	out := []string{}
	for len(line) > width {
		cut := width
		if idx := strings.LastIndex(line[:width], " "); idx >= width/3 {
			cut = idx
		}
		out = append(out, strings.TrimRight(line[:cut], " "))
		line = strings.TrimLeft(line[cut:], " ")
	}
	out = append(out, line)
	return out
}

func rightPad(value string, width int) string {
	if len(value) >= width {
		return value
	}
	return value + strings.Repeat(" ", width-len(value))
}

func compact(value string, max int) string {
	value = strings.Join(strings.Fields(value), " ")
	if max > 0 && len(value) > max {
		if max <= 3 {
			return value[:max]
		}
		return value[:max-3] + "..."
	}
	return value
}

func redactTerminalText(value string) string {
	return terminalSecretPattern.ReplaceAllString(value, "$1=[REDACTED]")
}

func blank(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func limited(items []string, max int) []string {
	if max <= 0 || len(items) <= max {
		return items
	}
	return items[:max]
}

func isFallback(metadata map[string]interface{}) bool {
	value, ok := metadata["fallback"]
	if !ok {
		return false
	}
	typed, ok := value.(bool)
	return ok && typed
}
