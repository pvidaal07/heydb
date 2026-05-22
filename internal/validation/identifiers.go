// Package validation provides input-validation helpers shared across the
// heydb CLI, TUI, and adapter layers. Functions return descriptive errors
// suitable for use as huh form Validate callbacks.
package validation

import (
	"fmt"
	"regexp"
)

var (
	// mysqlIdentifierRe matches valid MySQL identifiers: alphanumeric + underscore,
	// 1–64 characters. Hyphens are intentionally excluded — MySQL requires
	// backtick quoting for identifiers with hyphens, which we handle via
	// allow-listing rather than escaping.
	mysqlIdentifierRe = regexp.MustCompile(`^[a-zA-Z0-9_]{1,64}$`)

	// connectionNameRe matches valid heydb connection names. Hyphens are allowed
	// here because these names never appear inside SQL — they are internal labels.
	connectionNameRe = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

	// hostRe matches valid hostname/IP values plus the MySQL wildcard %.
	// Allowed chars: alphanumeric, dot, hyphen, colon (for port), percent.
	// Max 255 characters enforced separately.
	hostRe = regexp.MustCompile(`^[a-zA-Z0-9.\-%:]+$`)

	// sqlMetaRe matches any SQL metacharacter that must never appear in a host value.
	sqlMetaRe = regexp.MustCompile(`['` + "`" + `;]|--`)
)

// ValidateMySQLIdentifier returns nil if s is a valid MySQL identifier
// (username, database name, or table name): matches ^[a-zA-Z0-9_]{1,64}$.
// Returns a descriptive error otherwise. Hyphens are NOT allowed.
func ValidateMySQLIdentifier(s string) error {
	if s == "" {
		return fmt.Errorf("identifier must not be empty")
	}
	if len(s) > 64 {
		return fmt.Errorf("identifier must not exceed 64 characters (got %d)", len(s))
	}
	if !mysqlIdentifierRe.MatchString(s) {
		return fmt.Errorf("identifier %q contains invalid characters: only letters, digits and underscore are allowed", s)
	}
	return nil
}

// ValidateConnectionName returns nil if s is a valid heydb connection name:
// matches ^[a-zA-Z0-9_-]{1,64}$. Hyphens are allowed (connection names are
// internal labels, never embedded in SQL).
func ValidateConnectionName(s string) error {
	if s == "" {
		return fmt.Errorf("connection name must not be empty")
	}
	if len(s) > 64 {
		return fmt.Errorf("connection name must not exceed 64 characters (got %d)", len(s))
	}
	if !connectionNameRe.MatchString(s) {
		return fmt.Errorf("connection name %q contains invalid characters: only letters, digits, underscore and hyphen are allowed", s)
	}
	return nil
}

// ValidateHost returns nil if s is a valid host value for a MySQL GRANT or
// CREATE USER statement. Accepts hostnames, IPv4 addresses, and the MySQL
// wildcard %. Rejects SQL metacharacters and empty values.
func ValidateHost(s string) error {
	if s == "" {
		return fmt.Errorf("host must not be empty")
	}
	if len(s) > 255 {
		return fmt.Errorf("host must not exceed 255 characters (got %d)", len(s))
	}
	// Check for SQL metacharacters first — more informative error.
	if sqlMetaRe.MatchString(s) {
		return fmt.Errorf("host %q contains SQL metacharacters that are not allowed", s)
	}
	if !hostRe.MatchString(s) {
		return fmt.Errorf("host %q contains invalid characters: only alphanumeric, dot, hyphen, colon and %% are allowed", s)
	}
	return nil
}
