package registry

import "strings"

type RuleRegistry struct {
	rules   []Rule
	byID    map[string]Rule
	version string
}

func NewRuleRegistry(rules []Rule, version string) *RuleRegistry {
	reg := &RuleRegistry{rules: []Rule{}, byID: map[string]Rule{}, version: version}
	for _, rule := range rules {
		reg.Add(rule)
	}
	return reg
}

func (r *RuleRegistry) Add(rule Rule) {
	r.rules = append(r.rules, rule)
	r.byID[strings.ToLower(strings.TrimSpace(rule.RuleID))] = rule
}

func (r *RuleRegistry) GetAllRules() []Rule {
	out := make([]Rule, len(r.rules))
	copy(out, r.rules)
	return out
}

func (r *RuleRegistry) GetEnabledRules() []Rule {
	out := []Rule{}
	for _, rule := range r.rules {
		if rule.Enabled {
			out = append(out, rule)
		}
	}
	return out
}

func (r *RuleRegistry) FindRulesByTool(toolName string, toolID string) []Rule {
	out := []Rule{}
	for _, rule := range r.GetEnabledRules() {
		if len(rule.AppliesToTools) == 0 {
			continue
		}
		for _, item := range rule.AppliesToTools {
			if sameRef(item, toolName) || sameRef(item, toolID) {
				out = append(out, rule)
				break
			}
		}
	}
	return out
}

func (r *RuleRegistry) GetGlobalSafetyRules() []Rule {
	out := []Rule{}
	for _, rule := range r.GetEnabledRules() {
		if mandatoryGlobalRuleID(rule.RuleID) {
			out = append(out, rule)
		}
	}
	return out
}

func (r *RuleRegistry) Version() string {
	return r.version
}

func sameRef(a, b string) bool {
	return strings.EqualFold(strings.TrimSpace(a), strings.TrimSpace(b))
}

func mandatoryGlobalRuleID(ruleID string) bool {
	switch strings.ToUpper(strings.TrimSpace(ruleID)) {
	case "GLOBAL-SAFETY-001",
		"GLOBAL-SAFETY-003",
		"GLOBAL-SAFETY-008",
		"GLOBAL-SAFETY-009",
		"GLOBAL-SAFETY-010",
		"GLOBAL-SCORING-008",
		"GLOBAL-SCORING-009",
		"GLOBAL-SCORING-010":
		return true
	default:
		return false
	}
}
