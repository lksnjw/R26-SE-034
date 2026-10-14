package mcp

// Prompt represents a predefined instruction or template for an AI agent.
type Prompt struct {
	// Name is the unique identifier for the prompt.
	Name string `json:"name"`
	// Description provides a human-readable explanation of what the prompt does.
	Description string `json:"description"`
	// Arguments is an optional list of parameters required by the prompt template.
	Arguments []PromptArgument `json:"arguments,omitempty"`
	// Template is the actual instruction text sent to the AI.
	Template string `json:"template"`
}

// PromptArgument defines a single parameter used within a prompt template.
type PromptArgument struct {
	// Name of the argument.
	Name string `json:"name"`
	// Description of what the argument represents.
	Description string `json:"description"`
	// Required indicates if the argument must be provided.
	Required bool `json:"required"`
}
