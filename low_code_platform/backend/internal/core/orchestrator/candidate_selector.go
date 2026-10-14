package orchestrator

import workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"

type CandidateSelector struct{}

func NewCandidateSelector() CandidateSelector {
	return CandidateSelector{}
}

func (s CandidateSelector) Select(reports []CandidateReport) (CandidateReport, bool) {
	var selected CandidateReport
	found := false
	for _, report := range reports {
		if !report.Validation.Passed {
			continue
		}
		if !found || better(report.Validation, selected.Validation) {
			selected = report
			found = true
		}
	}
	return selected, found
}

func better(left, right workflowvalidator.CandidateValidationResult) bool {
	if left.Score != right.Score {
		return left.Score > right.Score
	}
	if riskRank(left.EstimatedRisk) != riskRank(right.EstimatedRisk) {
		return riskRank(left.EstimatedRisk) < riskRank(right.EstimatedRisk)
	}
	if left.StepCount != right.StepCount {
		return left.StepCount < right.StepCount
	}
	return left.CandidateID < right.CandidateID
}

func riskRank(risk string) int {
	switch risk {
	case "critical":
		return 4
	case "high":
		return 3
	case "medium":
		return 2
	case "low":
		return 1
	default:
		return 0
	}
}
