package registry

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"go.uber.org/zap"
)

type Bundle struct {
	Tools     *ToolRegistry
	Rules     *RuleRegistry
	Templates []ProcessTemplate
	Examples  []FewShotExample
	Versions  RegistryVersions
}

func LoadBundle(toolPath, rulePath string, log *zap.Logger) (*Bundle, error) {
	tools, toolVersion, err := loadTools(toolPath, log)
	if err != nil {
		return nil, err
	}
	rules, ruleVersion, err := loadRules(rulePath, log)
	if err != nil {
		return nil, err
	}
	return &Bundle{
		Tools:    NewToolRegistry(tools, toolVersion),
		Rules:    NewRuleRegistry(rules, ruleVersion),
		Versions: RegistryVersions{Tools: toolVersion, Rules: ruleVersion},
	}, nil
}

func LoadDataset(root string, log *zap.Logger) (*Bundle, error) {
	if strings.TrimSpace(root) == "" {
		root = "./dataset"
	}
	if log == nil {
		log = zap.NewNop()
	}

	tools, toolVersion, err := loadToolsFromDataset(filepath.Join(root, "01_tool_registries"), log)
	if err != nil {
		return nil, err
	}
	rules, ruleVersion, err := loadRulesFromDataset(filepath.Join(root, "02_governance_rules"), log)
	if err != nil {
		return nil, err
	}
	templates, templateVersion := loadTemplatesFromDataset(filepath.Join(root, "03_process_templates"), log)
	examples, exampleVersion := loadExamplesFromDataset(filepath.Join(root, "04_test_scenarios"), log)

	if len(tools) == 0 {
		return nil, fmt.Errorf("dataset root %s did not contain any tools", root)
	}
	if len(rules) == 0 {
		return nil, fmt.Errorf("dataset root %s did not contain any governance rules", root)
	}

	return &Bundle{
		Tools:     NewToolRegistry(tools, toolVersion),
		Rules:     NewRuleRegistry(rules, ruleVersion),
		Templates: templates,
		Examples:  examples,
		Versions:  RegistryVersions{Tools: toolVersion, Rules: ruleVersion, Templates: templateVersion, Examples: exampleVersion},
	}, nil
}

func loadTools(path string, log *zap.Logger) ([]Tool, string, error) {
	if strings.TrimSpace(path) == "" {
		log.Warn("tool registry path is empty; starting with empty tool registry")
		return []Tool{}, "empty", nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			log.Warn("tool registry file missing; starting with empty tool registry", zap.String("path", path))
			return []Tool{}, "missing", nil
		}
		return nil, "", fmt.Errorf("read tool registry %s: %w", path, err)
	}
	var tools []Tool
	if err := json.Unmarshal(raw, &tools); err != nil {
		return nil, "", fmt.Errorf("decode tool registry %s: %w", path, err)
	}
	return tools, checksum(raw), nil
}

func loadRules(path string, log *zap.Logger) ([]Rule, string, error) {
	if strings.TrimSpace(path) == "" {
		log.Warn("rule registry path is empty; starting with empty rule registry")
		return []Rule{}, "empty", nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			log.Warn("rule registry file missing; starting with empty rule registry", zap.String("path", path))
			return []Rule{}, "missing", nil
		}
		return nil, "", fmt.Errorf("read rule registry %s: %w", path, err)
	}
	var rules []Rule
	if err := json.Unmarshal(raw, &rules); err != nil {
		return nil, "", fmt.Errorf("decode rule registry %s: %w", path, err)
	}
	return rules, checksum(raw), nil
}

func checksum(raw []byte) string {
	sum := sha256.Sum256(raw)
	return "sha256:" + hex.EncodeToString(sum[:])[:16]
}

func loadToolsFromDataset(dir string, log *zap.Logger) ([]Tool, string, error) {
	files := jsonFiles(dir, log)
	seen := map[string]Tool{}
	for _, file := range files {
		var items []Tool
		if err := readJSONFile(file, &items); err != nil {
			return nil, "", fmt.Errorf("decode tool registry %s: %w", file, err)
		}
		source := relativeSource(dir, file)
		for _, item := range items {
			item.SourceFile = source
			key := registryKey(item.ToolID, item.Name)
			if key == "" {
				continue
			}
			seen[key] = item
		}
	}
	out := make([]Tool, 0, len(seen))
	for _, item := range seen {
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].ToolID < out[j].ToolID
	})
	return out, datasetVersion(files), nil
}

func loadRulesFromDataset(dir string, log *zap.Logger) ([]Rule, string, error) {
	files := jsonFiles(dir, log)
	seen := map[string]Rule{}
	for _, file := range files {
		var items []Rule
		if err := readJSONFile(file, &items); err != nil {
			return nil, "", fmt.Errorf("decode rule registry %s: %w", file, err)
		}
		source := relativeSource(dir, file)
		for _, item := range items {
			item.SourceFile = source
			key := strings.ToLower(strings.TrimSpace(item.RuleID))
			if key == "" {
				continue
			}
			seen[key] = item
		}
	}
	out := make([]Rule, 0, len(seen))
	for _, item := range seen {
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].RuleID < out[j].RuleID
	})
	return out, datasetVersion(files), nil
}

func loadTemplatesFromDataset(dir string, log *zap.Logger) ([]ProcessTemplate, string) {
	files := jsonFiles(dir, log)
	seen := map[string]ProcessTemplate{}
	for _, file := range files {
		var items []ProcessTemplate
		if err := readJSONFile(file, &items); err != nil {
			log.Warn("skip invalid process template file", zap.String("path", file), zap.Error(err))
			continue
		}
		source := relativeSource(dir, file)
		for _, item := range items {
			item.SourceFile = source
			key := strings.ToLower(strings.TrimSpace(item.TemplateID))
			if key == "" {
				continue
			}
			seen[key] = item
		}
	}
	out := make([]ProcessTemplate, 0, len(seen))
	for _, item := range seen {
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].TemplateID < out[j].TemplateID
	})
	return out, datasetVersion(files)
}

func loadExamplesFromDataset(dir string, log *zap.Logger) ([]FewShotExample, string) {
	files := jsonFiles(dir, log)
	seen := map[string]FewShotExample{}
	for _, file := range files {
		var items []FewShotExample
		if err := readJSONFile(file, &items); err != nil {
			log.Warn("skip invalid scenario example file", zap.String("path", file), zap.Error(err))
			continue
		}
		source := relativeSource(dir, file)
		for _, item := range items {
			item.SourceFile = source
			key := strings.ToLower(strings.TrimSpace(item.ScenarioID))
			if key == "" {
				key = strings.ToLower(strings.TrimSpace(item.UserRequest))
			}
			if key == "" {
				continue
			}
			seen[key] = item
		}
	}
	out := make([]FewShotExample, 0, len(seen))
	for _, item := range seen {
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].ScenarioID < out[j].ScenarioID
	})
	return out, datasetVersion(files)
}

func jsonFiles(dir string, log *zap.Logger) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			log.Warn("optional dataset folder missing", zap.String("path", dir))
			return nil
		}
		log.Warn("cannot read dataset folder", zap.String("path", dir), zap.Error(err))
		return nil
	}
	files := []string{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(strings.ToLower(entry.Name()), ".json") {
			continue
		}
		files = append(files, filepath.Join(dir, entry.Name()))
	}
	sort.Strings(files)
	if len(files) == 0 {
		log.Warn("dataset folder has no json files", zap.String("path", dir))
	}
	return files
}

func readJSONFile(path string, target interface{}) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, target)
}

func registryKey(id, name string) string {
	id = strings.ToLower(strings.TrimSpace(id))
	if id != "" {
		return id
	}
	return strings.ToLower(strings.TrimSpace(name))
}

func datasetVersion(files []string) string {
	hash := sha256.New()
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		hash.Write([]byte(file))
		hash.Write(raw)
	}
	sum := hash.Sum(nil)
	return "sha256:" + hex.EncodeToString(sum)[:16]
}

func relativeSource(root, file string) string {
	parent := filepath.Dir(root)
	rel, err := filepath.Rel(parent, file)
	if err != nil {
		return file
	}
	return filepath.ToSlash(rel)
}
