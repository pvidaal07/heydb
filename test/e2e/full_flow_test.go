package e2e_test

import "testing"

// TODO: Implement end-to-end tests using testcontainers-go MySQL 8.0.
// These tests require Docker to be available in the environment.
//
// When implemented, the full flow test should:
//   - Run `heydb init` in a temp directory
//   - Run `heydb sync` against a containerized MySQL
//   - Assert that .heydb/heydb.md and .heydb/heydb.sqlite are created
//   - Parse heydb.md and assert tables are present
//   - Start `heydb serve` as a subprocess
//   - Call heydb_list_tables via the MCP stdio protocol
//   - Assert the response matches the synced schema
//
// Reference: https://golang.testcontainers.org/

func TestFullFlow_RequiresDocker(t *testing.T) {
	t.Skip("requires Docker — e2e test not yet implemented")
}
