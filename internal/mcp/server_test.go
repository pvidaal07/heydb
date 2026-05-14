package mcp_test

import "testing"

// TODO: Implement integration tests using an in-process mcp-go test client.
// Blocked on mcp-go being pre-1.0 and lacking a stable test client API.
//
// When implemented, they should:
//   - Create a Store with a known schema
//   - Start heydb.Server with that store
//   - Call heydb_list_tables, heydb_get_table (hit and miss), heydb_search
//   - Assert results match the seeded schema
//
// Reference: https://github.com/mark3labs/mcp-go

func TestMCPServer_RequiresMCPTestClient(t *testing.T) {
	t.Skip("requires mcp-go test client — integration test not yet implemented")
}
