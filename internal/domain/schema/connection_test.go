package schema_test

import (
	"testing"

	"github.com/pvidaal07/heydb/internal/domain/schema"
)

func TestConnectionDSN(t *testing.T) {
	c := schema.Connection{
		Name:     "local",
		Host:     "127.0.0.1",
		Port:     3306,
		Database: "myapp",
		User:     "heydb_reader",
		Password: "s3cr3t",
	}

	got := c.DSN()
	want := "heydb_reader:s3cr3t@tcp(127.0.0.1:3306)/myapp?parseTime=true"
	if got != want {
		t.Errorf("DSN() = %q, want %q", got, want)
	}
}

func TestConnectionDSNDefaultPort(t *testing.T) {
	// A connection on a non-standard port should still produce the correct DSN.
	c := schema.Connection{
		Name:     "staging",
		Host:     "db.example.com",
		Port:     33060,
		Database: "staging_db",
		User:     "admin",
		Password: "pass",
	}

	got := c.DSN()
	want := "admin:pass@tcp(db.example.com:33060)/staging_db?parseTime=true"
	if got != want {
		t.Errorf("DSN() = %q, want %q", got, want)
	}
}
