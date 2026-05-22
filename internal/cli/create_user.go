package cli

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"strings"

	"github.com/charmbracelet/huh"
	"github.com/pvidaal07/heydb/internal/validation"
	"github.com/spf13/cobra"
)

var createUserCmd = &cobra.Command{
	Use:   "create-user",
	Short: "Generate SQL to create a read-only MySQL user",
	Long: `Interactively collects username, password, host, and permission scope,
then prints the required CREATE USER and GRANT SQL to stdout.

heydb NEVER executes this SQL — it is printed for you to review and run manually.`,
	RunE: runCreateUser,
}

func init() {
	rootCmd.AddCommand(createUserCmd)
}

// permScope enumerates the three supported permission scopes.
type permScope string

const (
	scopeSchemaOnly     permScope = "schema_only"
	scopeSelectAll      permScope = "select_all"
	scopeSelectSpecific permScope = "select_specific"
)

func runCreateUser(cmd *cobra.Command, args []string) error {
	var (
		mysqlUsername  = "heydb_reader"
		mysqlHost      = "%"
		mysqlDatabase  string
		passwordChoice = "generate"
		customPassword string
		scope          = string(scopeSchemaOnly)
		specificTables string
	)

	// ── Step 1: Basic info ───────────────────────────────────────────────────
	basicForm := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("MySQL username to create").
				Placeholder("heydb_reader").
				Validate(validation.ValidateMySQLIdentifier).
				Value(&mysqlUsername),

			huh.NewInput().
				Title("Host restriction").
				Description("Use % to allow connections from any host, or specify an IP/hostname").
				Placeholder("%").
				Validate(validation.ValidateHost).
				Value(&mysqlHost),

			huh.NewSelect[string]().
				Title("Password").
				Options(
					huh.NewOption("Generate a secure random password", "generate"),
					huh.NewOption("I will provide my own password", "custom"),
				).
				Value(&passwordChoice),
		),
	)

	if err := basicForm.Run(); err != nil {
		return fmt.Errorf("create-user: form cancelled: %w", err)
	}

	// ── Step 2: Custom password (only if chosen) ─────────────────────────────
	if passwordChoice == "custom" {
		pwForm := huh.NewForm(
			huh.NewGroup(
				huh.NewInput().
					Title("Password").
					EchoMode(huh.EchoModePassword).
					Validate(func(s string) error {
						if strings.TrimSpace(s) == "" {
							return fmt.Errorf("password cannot be empty")
						}
						return nil
					}).
					Value(&customPassword),
			),
		)
		if err := pwForm.Run(); err != nil {
			return fmt.Errorf("create-user: password form cancelled: %w", err)
		}
	}

	// ── Step 3: Permission scope ─────────────────────────────────────────────
	scopeForm := huh.NewForm(
		huh.NewGroup(
			huh.NewSelect[string]().
				Title("Permission scope").
				Description("What can this user access?").
				Options(
					huh.NewOption("Schema introspection only (INFORMATION_SCHEMA SELECT)", string(scopeSchemaOnly)),
					huh.NewOption("Schema + SELECT on all tables in a database", string(scopeSelectAll)),
					huh.NewOption("Schema + SELECT on specific tables in a database", string(scopeSelectSpecific)),
				).
				Value(&scope),
		),
	)

	if err := scopeForm.Run(); err != nil {
		return fmt.Errorf("create-user: scope form cancelled: %w", err)
	}

	// ── Step 4: Database name (if scope requires it) ─────────────────────────
	if scope == string(scopeSelectAll) || scope == string(scopeSelectSpecific) {
		dbForm := huh.NewForm(
			huh.NewGroup(
				huh.NewInput().
					Title("Database name").
					Placeholder("myapp").
					Validate(func(s string) error {
						if strings.TrimSpace(s) == "" {
							return fmt.Errorf("database name is required for this permission scope")
						}
						return validation.ValidateMySQLIdentifier(s)
					}).
					Value(&mysqlDatabase),
			),
		)
		if err := dbForm.Run(); err != nil {
			return fmt.Errorf("create-user: database form cancelled: %w", err)
		}
	}

	// ── Step 5: Specific tables (if scope requires it) ───────────────────────
	if scope == string(scopeSelectSpecific) {
		tablesForm := huh.NewForm(
			huh.NewGroup(
				huh.NewInput().
					Title("Table names").
					Description("Comma-separated list, e.g.: users, orders, products").
					Validate(func(s string) error {
						if strings.TrimSpace(s) == "" {
							return fmt.Errorf("at least one table name is required")
						}
						// Validate each table name individually.
						for _, raw := range strings.Split(s, ",") {
							table := strings.TrimSpace(raw)
							if table == "" {
								continue
							}
							if err := validation.ValidateMySQLIdentifier(table); err != nil {
								return fmt.Errorf("table %q: %w", table, err)
							}
						}
						return nil
					}).
					Value(&specificTables),
			),
		)
		if err := tablesForm.Run(); err != nil {
			return fmt.Errorf("create-user: tables form cancelled: %w", err)
		}
	}

	// ── Resolve password ─────────────────────────────────────────────────────
	var finalPassword string
	var generatedPassword string
	if passwordChoice == "generate" {
		p, err := generatePassword(24)
		if err != nil {
			return fmt.Errorf("create-user: generate password: %w", err)
		}
		finalPassword = p
		generatedPassword = p
	} else {
		finalPassword = customPassword
	}

	mysqlUsername = strings.TrimSpace(mysqlUsername)
	mysqlHost = strings.TrimSpace(mysqlHost)
	mysqlDatabase = strings.TrimSpace(mysqlDatabase)

	// ── Generate SQL ─────────────────────────────────────────────────────────
	sql, err := buildCreateUserSQL(mysqlUsername, finalPassword, mysqlHost, permScope(scope), mysqlDatabase, specificTables)
	if err != nil {
		return fmt.Errorf("create-user: %w", err)
	}

	// ── Print output ─────────────────────────────────────────────────────────
	fmt.Println()
	fmt.Println("-- ============================================================")
	fmt.Println("-- heydb create-user — generated SQL (NOT executed by heydb)")
	fmt.Println("-- Review the statements below and run them in your MySQL client.")
	fmt.Println("-- ============================================================")
	fmt.Println()
	fmt.Println(sql)
	fmt.Println("-- ============================================================")

	if generatedPassword != "" {
		fmt.Println()
		fmt.Println("Generated password (save this — it will not be shown again):")
		fmt.Printf("  %s\n", generatedPassword)
	}

	fmt.Println()
	fmt.Println("NOTE: heydb did NOT execute any of the above SQL.")
	fmt.Println("      Copy it into your MySQL client (e.g. mysql -u root -p) and run it manually.")

	return nil
}

// buildCreateUserSQL assembles the CREATE USER + GRANT + FLUSH SQL string.
// Returns an error if any identifier or host value fails validation — no SQL
// is produced in that case. Passwords are never rejected; single quotes are
// escaped as '' (standard SQL string escaping).
func buildCreateUserSQL(username, password, host string, scope permScope, database, specificTables string) (string, error) {
	// Validate identifiers.
	if err := validation.ValidateMySQLIdentifier(username); err != nil {
		return "", fmt.Errorf("invalid username: %w", err)
	}
	if err := validation.ValidateHost(host); err != nil {
		return "", fmt.Errorf("invalid host: %w", err)
	}
	if scope == scopeSelectAll || scope == scopeSelectSpecific {
		if err := validation.ValidateMySQLIdentifier(database); err != nil {
			return "", fmt.Errorf("invalid database name: %w", err)
		}
	}
	if scope == scopeSelectSpecific {
		for _, raw := range strings.Split(specificTables, ",") {
			table := strings.TrimSpace(raw)
			if table == "" {
				continue
			}
			if err := validation.ValidateMySQLIdentifier(table); err != nil {
				return "", fmt.Errorf("invalid table name: %w", err)
			}
		}
	}

	// Password is not validated (any content is allowed) — only escaped.
	safePassword := escapeSingleQuote(password)

	var b strings.Builder

	b.WriteString(fmt.Sprintf("CREATE USER '%s'@'%s' IDENTIFIED BY '%s';\n", username, host, safePassword))
	b.WriteString("\n")

	switch scope {
	case scopeSchemaOnly:
		b.WriteString(fmt.Sprintf("GRANT SELECT ON information_schema.* TO '%s'@'%s';\n", username, host))

	case scopeSelectAll:
		b.WriteString(fmt.Sprintf("GRANT SELECT ON information_schema.* TO '%s'@'%s';\n", username, host))
		b.WriteString(fmt.Sprintf("GRANT SELECT ON `%s`.* TO '%s'@'%s';\n", database, username, host))

	case scopeSelectSpecific:
		b.WriteString(fmt.Sprintf("GRANT SELECT ON information_schema.* TO '%s'@'%s';\n", username, host))
		for _, rawTable := range strings.Split(specificTables, ",") {
			table := strings.TrimSpace(rawTable)
			if table == "" {
				continue
			}
			b.WriteString(fmt.Sprintf("GRANT SELECT ON `%s`.`%s` TO '%s'@'%s';\n",
				database, table, username, host))
		}
	}

	b.WriteString("\n")
	b.WriteString("FLUSH PRIVILEGES;\n")

	return b.String(), nil
}

// escapeSingleQuote escapes single-quote characters in s by doubling them
// (SQL standard: ' → ''). This makes s safe for interpolation inside a
// single-quoted SQL string literal.
func escapeSingleQuote(s string) string {
	return strings.ReplaceAll(s, "'", "''")
}

// generatePassword returns a cryptographically random password of the given
// byte length (the base64-encoded result is longer).
func generatePassword(byteLen int) (string, error) {
	buf := make([]byte, byteLen)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	// Use URL-safe base64 without padding to get a printable string.
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
