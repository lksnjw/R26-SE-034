# Shared Utilities (`pkg`)

The `pkg/` directory contains shared Go packages that provide utility functions used throughout the backend.

## Logger (`pkg/logger/`)

- **`zap_logger.go`**: A structured logging wrapper around `uber-go/zap`. It supports multiple log levels, structured context (key-value pairs), and environment-specific formatting (JSON for production, colorized text for development).

## Parser (`pkg/parser/`)

- **`regex_util.go`**: Utilities for extracting structured data from LLM responses using regular expressions (e.g., extracting YAML blocks).
- **`yaml_util.go`**: Utilities for parsing and validating YAML strings, specifically tailored for the workflow blueprint format.
