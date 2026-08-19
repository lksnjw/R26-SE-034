// Package types defines sensitive domain primitives and custom redacted types for ERPBridge.
package types

// APIToken represents a sensitive API credential.
type APIToken string

// Password represents a sensitive password.
type Password string

// AuthHeader represents a sensitive authorization header.
type AuthHeader string

// SecretKey represents a sensitive secret key.
type SecretKey string

// PII represents Personally Identifiable Information (emails, phone numbers, etc.).
type PII string
