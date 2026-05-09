package semanticsearch

import (
	"regexp"
	"sort"
	"strings"
)

var tokenPattern = regexp.MustCompile(`[a-zA-Z0-9_.-]+`)

func tokenize(value string) []string {
	matches := tokenPattern.FindAllString(strings.ToLower(value), -1)
	out := make([]string, 0, len(matches))
	for _, item := range matches {
		if len(item) < 2 {
			continue
		}
		out = append(out, item)
	}
	return out
}

func tokenSet(value string) map[string]bool {
	out := map[string]bool{}
	for _, token := range tokenize(value) {
		addTokenVariant(out, token)
		for _, part := range strings.FieldsFunc(token, func(r rune) bool { return r == '.' || r == '_' || r == '-' }) {
			if len(part) > 1 {
				addTokenVariant(out, part)
			}
		}
	}
	return out
}

func addTokenVariant(out map[string]bool, token string) {
	out[token] = true
	if len(token) > 3 && strings.HasSuffix(token, "s") {
		out[strings.TrimSuffix(token, "s")] = true
	}
}

func lexicalScore(query, document string) (float64, []string) {
	querySet := tokenSet(query)
	docSet := tokenSet(document)
	if len(querySet) == 0 || len(docSet) == 0 {
		return 0, nil
	}

	matches := []string{}
	for token := range querySet {
		if docSet[token] {
			matches = append(matches, token)
		}
	}
	sort.Strings(matches)

	score := float64(len(matches)) / float64(len(querySet))
	lowerDoc := strings.ToLower(document)
	lowerQuery := strings.ToLower(query)
	if strings.Contains(lowerDoc, lowerQuery) {
		score += 0.35
	}
	if score > 1 {
		score = 1
	}
	return score, matches
}

func reason(matches []string, fallback string) string {
	if len(matches) == 0 {
		return fallback
	}
	if len(matches) > 8 {
		matches = matches[:8]
	}
	return "Matched terms: " + strings.Join(matches, ", ")
}
