package config

import (
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/joho/godotenv"
)

type Config struct {
	AppName      string
	Environment  string
	Host         string
	Port         string
	APIBasePath  string
	FrontendURL  string
	JWTSecret    string
	TokenTTL     time.Duration
	AllowDevAuth bool

	DatabaseURL string
	RedisURL    string

	OllamaBaseURL string
	OllamaModel   string
	OllamaEnabled bool

	MCPBaseURL string
	MCPTimeout time.Duration

	DatasetRoot                        string
	ToolRegistryPath                   string
	RuleRegistryPath                   string
	SemanticSearchMode                 string
	SemanticSearchURL                  string
	SemanticSearchTopKTools            int
	SemanticSearchTopKRules            int
	SemanticSearchTopKTemplates        int
	SemanticSearchTopKExamples         int
	SemanticSearchAllowLexicalFallback bool
	WorkflowGenerationProvider         string
	GeminiAPIKey                       string
	GeminiModel                        string
	CandidateCount                     int
}

func Load() Config {
	_ = godotenv.Load(".env.local", ".env.development", ".env")

	return Config{
		AppName:                            getEnv("APP_NAME", "Agentic Workflow Engine"),
		Environment:                        getEnv("APP_ENV", "development"),
		Host:                               getEnv("APP_HOST", "0.0.0.0"),
		Port:                               getEnv("APP_PORT", "8080"),
		APIBasePath:                        getEnv("API_BASE_PATH", "/api"),
		FrontendURL:                        getEnv("FRONTEND_URL", "http://127.0.0.1:5173"),
		JWTSecret:                          getEnv("JWT_SECRET", "local-development-secret-change-me"),
		TokenTTL:                           time.Duration(getEnvInt("JWT_EXPIRES_MINUTES", 60)) * time.Minute,
		AllowDevAuth:                       getEnvBool("ALLOW_DEV_AUTH", true),
		DatabaseURL:                        getEnv("DATABASE_URL", "postgres://workflow:workflow@localhost:5432/workflow?sslmode=disable"),
		RedisURL:                           getEnv("REDIS_URL", "redis://localhost:6379/0"),
		OllamaBaseURL:                      strings.TrimRight(getEnv("OLLAMA_BASE_URL", "http://localhost:11434"), "/"),
		OllamaModel:                        getEnv("OLLAMA_MODEL", "phi3:mini"),
		OllamaEnabled:                      getEnvBool("OLLAMA_ENABLED", false),
		MCPBaseURL:                         strings.TrimRight(getEnv("MCP_BASE_URL", ""), "/"),
		MCPTimeout:                         time.Duration(getEnvInt("MCP_TIMEOUT_SECONDS", 15)) * time.Second,
		DatasetRoot:                        getEnv("DATASET_ROOT", "./dataset"),
		ToolRegistryPath:                   getEnv("TOOL_REGISTRY_PATH", ""),
		RuleRegistryPath:                   getEnv("RULE_REGISTRY_PATH", ""),
		SemanticSearchMode:                 getEnv("SEMANTIC_SEARCH_MODE", "external_embedding"),
		SemanticSearchURL:                  strings.TrimRight(getEnv("SEMANTIC_SEARCH_URL", "http://localhost:8090/search"), "/"),
		SemanticSearchTopKTools:            getEnvInt("SEMANTIC_SEARCH_TOP_K_TOOLS", 10),
		SemanticSearchTopKRules:            getEnvInt("SEMANTIC_SEARCH_TOP_K_RULES", 15),
		SemanticSearchTopKTemplates:        getEnvInt("SEMANTIC_SEARCH_TOP_K_TEMPLATES", 5),
		SemanticSearchTopKExamples:         getEnvInt("SEMANTIC_SEARCH_TOP_K_EXAMPLES", 5),
		SemanticSearchAllowLexicalFallback: getEnvBool("SEMANTIC_SEARCH_ALLOW_LEXICAL_FALLBACK", false),
		WorkflowGenerationProvider:         getEnv("WORKFLOW_GENERATION_PROVIDER", "gemini"),
		GeminiAPIKey:                       getEnv("GEMINI_API_KEY", ""),
		GeminiModel:                        getEnv("GEMINI_MODEL", "gemini-1.5-flash"),
		CandidateCount:                     getEnvInt("CANDIDATE_COUNT", 5),
	}
}

func getEnv(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}

	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}

	return parsed
}

func getEnvBool(key string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}

	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}

	return parsed
}
