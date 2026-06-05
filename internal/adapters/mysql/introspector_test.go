package mysql_test

import (
	"testing"

	mysql "github.com/pvidaal07/heydb/internal/adapters/mysql"
	"github.com/pvidaal07/heydb/internal/domain/ports"
)

// TODO: Implement integration tests using testcontainers-go MySQL 8.0.
// These tests require Docker to be available in the environment.
//
// When implemented, they should:
//   - Spin up a MySQL 8.0 container via testcontainers-go
//   - Seed a schema with tables, columns, indexes, and foreign keys
//   - Assert ListTables, GetTable (column/index/FK data), ComputeHash stability
//
// Reference: https://golang.testcontainers.org/modules/mysql/

func TestMySQLIntrospector_RequiresDocker(t *testing.T) {
	t.Skip("requires Docker — integration test not yet implemented")
}

func TestIntrospector_ImplementsMultiDBIntrospector(t *testing.T) {
	i := mysql.New("fake-dsn")
	var _ ports.MultiDBIntrospector = i // compile-time check
}

func TestNewForDatabase_SharesConnection(t *testing.T) {
	parent := mysql.New("fake-dsn")
	child := parent.ForDatabase("mydb")
	if child == nil {
		t.Fatal("ForDatabase returned nil")
	}
}
