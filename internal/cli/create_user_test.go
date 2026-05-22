package cli

import (
	"strings"
	"testing"
)

// buildCreateUserSQL and generatePassword are unexported — tested here in
// the same package (white-box testing).

// ── Valid inputs (existing tests updated for (string, error) return) ──────────

func TestBuildCreateUserSQL_SchemaOnly(t *testing.T) {
	sql, err := buildCreateUserSQL("reader", "pass123", "%", scopeSchemaOnly, "", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	assertContains(t, sql, "CREATE USER 'reader'@'%' IDENTIFIED BY 'pass123';")
	assertContains(t, sql, "GRANT SELECT ON information_schema.*")
	assertContains(t, sql, "FLUSH PRIVILEGES;")

	// Must NOT grant any database-level access
	if strings.Contains(sql, "GRANT SELECT ON `") {
		t.Error("schema_only scope should not contain database-level GRANT SELECT ON `...`")
	}
}

func TestBuildCreateUserSQL_SelectAll(t *testing.T) {
	sql, err := buildCreateUserSQL("reader", "pass", "localhost", scopeSelectAll, "myapp", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	assertContains(t, sql, "CREATE USER 'reader'@'localhost' IDENTIFIED BY 'pass';")
	assertContains(t, sql, "GRANT SELECT ON information_schema.*")
	assertContains(t, sql, "GRANT SELECT ON `myapp`.* TO 'reader'@'localhost';")
	assertContains(t, sql, "FLUSH PRIVILEGES;")
}

func TestBuildCreateUserSQL_SelectSpecific(t *testing.T) {
	sql, err := buildCreateUserSQL("reader", "pass", "%", scopeSelectSpecific, "myapp", "users, orders, products")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	assertContains(t, sql, "CREATE USER 'reader'@'%' IDENTIFIED BY 'pass';")
	assertContains(t, sql, "GRANT SELECT ON information_schema.*")
	assertContains(t, sql, "GRANT SELECT ON `myapp`.`users` TO 'reader'@'%';")
	assertContains(t, sql, "GRANT SELECT ON `myapp`.`orders` TO 'reader'@'%';")
	assertContains(t, sql, "GRANT SELECT ON `myapp`.`products` TO 'reader'@'%';")
	assertContains(t, sql, "FLUSH PRIVILEGES;")

	// Must NOT grant wildcard access
	if strings.Contains(sql, "GRANT SELECT ON `myapp`.*") {
		t.Error("select_specific should not contain wildcard grant")
	}
}

func TestBuildCreateUserSQL_HostIsInjected(t *testing.T) {
	sql, err := buildCreateUserSQL("u", "p", "10.0.0.5", scopeSchemaOnly, "", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertContains(t, sql, "'u'@'10.0.0.5'")
}

func TestBuildCreateUserSQL_SpecificTablesTrimsSpaces(t *testing.T) {
	sql, err := buildCreateUserSQL("r", "p", "%", scopeSelectSpecific, "db", "  tbl1 ,  tbl2  ")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertContains(t, sql, "GRANT SELECT ON `db`.`tbl1` TO 'r'@'%';")
	assertContains(t, sql, "GRANT SELECT ON `db`.`tbl2` TO 'r'@'%';")
}

// ── Injection rejection tests (new, Phase 3) ──────────────────────────────────

func TestBuildCreateUserSQL_RejectsInjectionInUsername(t *testing.T) {
	injections := []string{
		"'; DROP TABLE users; --",
		"root'--",
		"user`name",
		"user;name",
		"user name",
		"my-user",
	}
	for _, payload := range injections {
		_, err := buildCreateUserSQL(payload, "pass", "%", scopeSchemaOnly, "", "")
		if err == nil {
			t.Errorf("buildCreateUserSQL: expected error for username=%q, got nil", payload)
		}
	}
}

func TestBuildCreateUserSQL_RejectsInjectionInDatabase(t *testing.T) {
	injections := []string{
		"`mydb` UNION SELECT",
		"mydb; DROP TABLE users",
		"my-db",
	}
	for _, payload := range injections {
		_, err := buildCreateUserSQL("reader", "pass", "%", scopeSelectAll, payload, "")
		if err == nil {
			t.Errorf("buildCreateUserSQL: expected error for database=%q, got nil", payload)
		}
	}
}

func TestBuildCreateUserSQL_RejectsInjectionInTable(t *testing.T) {
	injections := []string{
		"users`; DROP TABLE users; --",
		"tbl'injection",
		"my-table",
	}
	for _, payload := range injections {
		_, err := buildCreateUserSQL("reader", "pass", "%", scopeSelectSpecific, "mydb", payload)
		if err == nil {
			t.Errorf("buildCreateUserSQL: expected error for table=%q, got nil", payload)
		}
	}
}

func TestBuildCreateUserSQL_RejectsInjectionInHost(t *testing.T) {
	injections := []string{
		"'; DROP TABLE users; --",
		"host`name",
		"host;name",
	}
	for _, payload := range injections {
		_, err := buildCreateUserSQL("reader", "pass", payload, scopeSchemaOnly, "", "")
		if err == nil {
			t.Errorf("buildCreateUserSQL: expected error for host=%q, got nil", payload)
		}
	}
}

// ── Password escaping (new, Phase 3) ─────────────────────────────────────────

func TestBuildCreateUserSQL_EscapesSingleQuoteInPassword(t *testing.T) {
	sql, err := buildCreateUserSQL("reader", "pass'word", "%", scopeSchemaOnly, "", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Single quote in password must be escaped as ''
	assertContains(t, sql, "IDENTIFIED BY 'pass''word'")
}

func TestBuildCreateUserSQL_PasswordWithDoubleDash(t *testing.T) {
	// Passwords with -- are enclosed in a string literal, so they're safe.
	sql, err := buildCreateUserSQL("reader", "pass--word", "%", scopeSchemaOnly, "", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertContains(t, sql, "IDENTIFIED BY 'pass--word'")
}

func TestBuildCreateUserSQL_PasswordWithSemicolon(t *testing.T) {
	// Semicolons are enclosed in the string literal — safe after escaping.
	sql, err := buildCreateUserSQL("reader", "pass;word", "%", scopeSchemaOnly, "", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	assertContains(t, sql, "IDENTIFIED BY 'pass;word'")
}

// ── escapeSingleQuote ─────────────────────────────────────────────────────────

func TestEscapeSingleQuote_BasicEscape(t *testing.T) {
	got := escapeSingleQuote("pass'word")
	want := "pass''word"
	if got != want {
		t.Errorf("escapeSingleQuote: want %q, got %q", want, got)
	}
}

func TestEscapeSingleQuote_MultipleQuotes(t *testing.T) {
	got := escapeSingleQuote("it's a 'test'")
	want := "it''s a ''test''"
	if got != want {
		t.Errorf("escapeSingleQuote: want %q, got %q", want, got)
	}
}

func TestEscapeSingleQuote_NoQuotes(t *testing.T) {
	got := escapeSingleQuote("normalpassword")
	if got != "normalpassword" {
		t.Errorf("escapeSingleQuote: no-op expected, got %q", got)
	}
}

func TestEscapeSingleQuote_EmptyString(t *testing.T) {
	got := escapeSingleQuote("")
	if got != "" {
		t.Errorf("escapeSingleQuote: empty string expected, got %q", got)
	}
}

// ── generatePassword ──────────────────────────────────────────────────────────

func TestGeneratePassword_NonEmpty(t *testing.T) {
	p, err := generatePassword(24)
	if err != nil {
		t.Fatalf("generatePassword error: %v", err)
	}
	if p == "" {
		t.Error("generated password should not be empty")
	}
}

func TestGeneratePassword_MinimumLength(t *testing.T) {
	p, err := generatePassword(24)
	if err != nil {
		t.Fatalf("generatePassword error: %v", err)
	}
	// base64 of 24 bytes = 32 chars (URL-safe, no padding)
	if len(p) < 20 {
		t.Errorf("generated password too short: %d chars (want >= 20)", len(p))
	}
}

func TestGeneratePassword_Randomness(t *testing.T) {
	p1, _ := generatePassword(24)
	p2, _ := generatePassword(24)
	if p1 == p2 {
		t.Error("two generated passwords should not be equal (collision is astronomically unlikely)")
	}
}

// assertContains is a helper that fails the test if s does not contain substr.
func assertContains(t *testing.T, s, substr string) {
	t.Helper()
	if !strings.Contains(s, substr) {
		t.Errorf("expected output to contain:\n  %q\ngot:\n%s", substr, s)
	}
}
