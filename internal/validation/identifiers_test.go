package validation_test

import (
	"testing"

	"github.com/pvidaal07/heydb/internal/validation"
)

// ── ValidateMySQLIdentifier ───────────────────────────────────────────────────

func TestValidateMySQLIdentifier(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantErr bool
	}{
		// Valid identifiers
		{name: "simple name", input: "users", wantErr: false},
		{name: "with underscore", input: "user_accounts", wantErr: false},
		{name: "with numbers", input: "table1", wantErr: false},
		{name: "mixed case", input: "MyDatabase", wantErr: false},
		{name: "single char", input: "a", wantErr: false},
		{name: "64 chars", input: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1", wantErr: false},
		{name: "all digits", input: "123", wantErr: false},

		// Invalid: SQL injection and special characters
		{name: "single quote", input: "'", wantErr: true},
		{name: "injection: drop table", input: "'; DROP TABLE users; --", wantErr: true},
		{name: "backtick", input: "`users`", wantErr: true},
		{name: "semicolon", input: "users;", wantErr: true},
		{name: "double dash", input: "users--", wantErr: true},
		{name: "space", input: "user name", wantErr: true},
		{name: "dot", input: "my.table", wantErr: true},

		// Invalid: hyphens not allowed in MySQL identifiers
		{name: "hyphen", input: "my-table", wantErr: true},

		// Invalid: empty and too long
		{name: "empty string", input: "", wantErr: true},
		{name: "65 chars", input: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1", wantErr: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := validation.ValidateMySQLIdentifier(tc.input)
			if tc.wantErr && err == nil {
				t.Errorf("ValidateMySQLIdentifier(%q): expected error, got nil", tc.input)
			}
			if !tc.wantErr && err != nil {
				t.Errorf("ValidateMySQLIdentifier(%q): unexpected error: %v", tc.input, err)
			}
		})
	}
}

// ── ValidateConnectionName ────────────────────────────────────────────────────

func TestValidateConnectionName(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantErr bool
	}{
		// Valid
		{name: "simple name", input: "myconn", wantErr: false},
		{name: "with hyphen", input: "my-conn", wantErr: false},
		{name: "with underscore", input: "my_conn", wantErr: false},
		{name: "with numbers", input: "conn1", wantErr: false},
		{name: "mixed case", input: "MyConn", wantErr: false},
		{name: "single char", input: "a", wantErr: false},
		{name: "64 chars", input: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1", wantErr: false},

		// Invalid
		{name: "empty string", input: "", wantErr: true},
		{name: "65 chars", input: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1", wantErr: true},
		{name: "space", input: "my conn", wantErr: true},
		{name: "single quote", input: "my'conn", wantErr: true},
		{name: "backtick", input: "my`conn", wantErr: true},
		{name: "semicolon", input: "my;conn", wantErr: true},
		{name: "at sign", input: "my@conn", wantErr: true},
		{name: "dot", input: "my.conn", wantErr: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := validation.ValidateConnectionName(tc.input)
			if tc.wantErr && err == nil {
				t.Errorf("ValidateConnectionName(%q): expected error, got nil", tc.input)
			}
			if !tc.wantErr && err != nil {
				t.Errorf("ValidateConnectionName(%q): unexpected error: %v", tc.input, err)
			}
		})
	}
}

// ── ValidateHost ──────────────────────────────────────────────────────────────

func TestValidateHost(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantErr bool
	}{
		// Valid
		{name: "wildcard percent", input: "%", wantErr: false},
		{name: "localhost", input: "localhost", wantErr: false},
		{name: "IPv4", input: "10.0.0.5", wantErr: false},
		{name: "hostname with dots", input: "db.example.com", wantErr: false},
		{name: "hostname with hyphens", input: "my-host.example.com", wantErr: false},
		{name: "IPv6-ish brackets", input: "192.168.1.100", wantErr: false},
		{name: "port notation", input: "localhost:3306", wantErr: false},

		// Invalid
		{name: "empty", input: "", wantErr: true},
		{name: "single quote", input: "host'name", wantErr: true},
		{name: "injection: semicolon", input: "host; DROP TABLE users; --", wantErr: true},
		{name: "double dash", input: "host--comment", wantErr: true},
		{name: "backtick", input: "`host`", wantErr: true},
		{name: "too long", input: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", wantErr: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := validation.ValidateHost(tc.input)
			if tc.wantErr && err == nil {
				t.Errorf("ValidateHost(%q): expected error, got nil", tc.input)
			}
			if !tc.wantErr && err != nil {
				t.Errorf("ValidateHost(%q): unexpected error: %v", tc.input, err)
			}
		})
	}
}
