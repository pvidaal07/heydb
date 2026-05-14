package mysql_test

import "testing"

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
