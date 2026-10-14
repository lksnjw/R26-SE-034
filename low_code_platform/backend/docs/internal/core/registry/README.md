# Registry Management

The `internal/core/registry` package manages the loading and indexing of tools, rules, and templates.

## Loader (`loader.go`)

The `Loader` is the primary entry point for loading the system's "knowledge base".
- **Dataset Loading**: Reads JSON files from the `./dataset` directory.
- **Aggregation**: Combines tools, governance rules, process templates, and few-shot examples into memory.
- **Checksumming**: Calculates version checksums for bundles to ensure consistency across the system.

## Registries (`tool_registry.go`, `rule_registry.go`)

- **Tool Registry**: Provides thread-safe lookup of tool definitions by ID. It bridges the gap between static definitions in JSON and the actual Go implementations.
- **Rule Registry**: Stores governance and safety rules, organized by domain and severity. It is primarily used by the `Validator` to enforce compliance.
