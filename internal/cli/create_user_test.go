package cli

import (
	"strings"
	"testing"
)

// buildCreateUserSQL and generatePassword are unexported — tested here in
// the same package (white-box testing).

func TestBuildCreateUserSQL_SchemaOnly(t *testing.T) {
	sql := buildCreateUserSQL("reader", "pass123", "%", scopeSchemaOnly, "", "")

	assertContains(t, sql, "CREATE USER 'reader'@'%' IDENTIFIED BY 'pass123';")
	assertContains(t, sql, "GRANT SELECT ON information_schema.*")
	assertContains(t, sql, "FLUSH PRIVILEGES;")

	// Must NOT grant any database-level access
	if strings.Contains(sql, "GRANT SELECT ON `") {
		t.Error("schema_only scope should not contain database-level GRANT SELECT ON `...`")
	}
}

func TestBuildCreateUserSQL_SelectAll(t *testing.T) {
	sql := buildCreateUserSQL("reader", "pass", "localhost", scopeSelectAll, "myapp", "")

	assertContains(t, sql, "CREATE USER 'reader'@'localhost' IDENTIFIED BY 'pass';")
	assertContains(t, sql, "GRANT SELECT ON information_schema.*")
	assertContains(t, sql, "GRANT SELECT ON `myapp`.* TO 'reader'@'localhost';")
	assertContains(t, sql, "FLUSH PRIVILEGES;")
}

func TestBuildCreateUserSQL_SelectSpecific(t *testing.T) {
	sql := buildCreateUserSQL("reader", "pass", "%", scopeSelectSpecific, "myapp", "users, orders, products")

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
	sql := buildCreateUserSQL("u", "p", "10.0.0.5", scopeSchemaOnly, "", "")
	assertContains(t, sql, "'u'@'10.0.0.5'")
}

func TestBuildCreateUserSQL_SpecificTablesTrimsSpaces(t *testing.T) {
	sql := buildCreateUserSQL("r", "p", "%", scopeSelectSpecific, "db", "  tbl1 ,  tbl2  ")
	assertContains(t, sql, "GRANT SELECT ON `db`.`tbl1` TO 'r'@'%';")
	assertContains(t, sql, "GRANT SELECT ON `db`.`tbl2` TO 'r'@'%';")
}

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
