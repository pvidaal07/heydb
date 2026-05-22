package mcp_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	mcpgo "github.com/mark3labs/mcp-go/mcp"
	mcpclient "github.com/mark3labs/mcp-go/client"

	"github.com/pvidaal07/heydb/internal/domain/schema"
	"github.com/pvidaal07/heydb/internal/mcp"
)

// ── test helpers ──────────────────────────────────────────────────────────────

// testProjectID is the project ID used in all server tests.
const testProjectID = "test-project-1"

// newTestServer builds a Server with a multi-connection registry for testing.
//
//	production — active, synced, has "users" and "orders" tables
//	staging    — inactive, synced, has "products" table
//	analytics  — inactive, NOT synced (no entry in registry)
func newTestServer(t *testing.T) *mcp.Server {
	t.Helper()
	production := &mcp.ConnEntry{
		Schema: &mockSchemaStore{tables: []schema.Table{
			{Name: "users", Columns: []schema.Column{{Name: "id"}, {Name: "email"}}},
			{Name: "orders", Columns: []schema.Column{{Name: "id"}, {Name: "total"}, {Name: "user_id"}}},
		}},
		Annotations:   &mockAnnotationStore{},
		Relationships: &mockRelationshipStore{},
	}
	staging := &mcp.ConnEntry{
		Schema: &mockSchemaStore{tables: []schema.Table{
			{Name: "products", Columns: []schema.Column{{Name: "id"}, {Name: "name"}}},
		}},
		Annotations:   &mockAnnotationStore{},
		Relationships: &mockRelationshipStore{},
	}

	reg := mcp.NewRegistry(
		map[string]*mcp.ConnEntry{
			"production": production,
			"staging":    staging,
			// analytics: no entry — unsynced
		},
		[]string{"analytics", "production", "staging"},
		"production",
	)

	return mcp.NewWithMeta(reg, testProjectID, "test-author")
}

// callTool creates an in-process MCP client, initializes it, calls the named
// tool with args, and returns the result. It fails the test on any protocol error.
func callTool(t *testing.T, srv *mcp.Server, toolName string, args map[string]any) *mcpgo.CallToolResult {
	t.Helper()

	client, err := mcpclient.NewInProcessClient(srv.MCPServer())
	if err != nil {
		t.Fatalf("NewInProcessClient: %v", err)
	}
	defer client.Close()

	ctx := context.Background()
	if err := client.Start(ctx); err != nil {
		t.Fatalf("client.Start: %v", err)
	}

	initReq := mcpgo.InitializeRequest{}
	initReq.Params.ProtocolVersion = mcpgo.LATEST_PROTOCOL_VERSION
	initReq.Params.ClientInfo = mcpgo.Implementation{Name: "test", Version: "0"}
	if _, err := client.Initialize(ctx, initReq); err != nil {
		t.Fatalf("client.Initialize: %v", err)
	}

	req := mcpgo.CallToolRequest{}
	req.Params.Name = toolName
	req.Params.Arguments = args

	result, err := client.CallTool(ctx, req)
	if err != nil {
		t.Fatalf("CallTool(%q): %v", toolName, err)
	}
	return result
}

// firstText extracts the text from the first content item of a CallToolResult.
func firstText(t *testing.T, result *mcpgo.CallToolResult) string {
	t.Helper()
	if len(result.Content) == 0 {
		t.Fatal("CallToolResult has no content")
	}
	tc, ok := result.Content[0].(mcpgo.TextContent)
	if !ok {
		t.Fatalf("first content item is not TextContent: %T", result.Content[0])
	}
	return tc.Text
}

// ── TestServer_ListConnections ────────────────────────────────────────────────

func TestServer_ListConnections(t *testing.T) {
	srv := newTestServer(t)
	result := callTool(t, srv, "heydb_list_connections", nil)

	if result.IsError {
		t.Fatalf("heydb_list_connections returned error: %s", firstText(t, result))
	}

	text := firstText(t, result)
	var conns []mcp.ConnectionInfo
	if err := json.Unmarshal([]byte(text), &conns); err != nil {
		t.Fatalf("unmarshal response: %v\nraw: %s", err, text)
	}

	// Expect 3 entries: analytics, production, staging (sorted)
	if len(conns) != 3 {
		t.Fatalf("expected 3 connections; got %d", len(conns))
	}

	wantOrder := []string{"analytics", "production", "staging"}
	for i, name := range wantOrder {
		if conns[i].Name != name {
			t.Errorf("conns[%d].Name = %q; want %q", i, conns[i].Name, name)
		}
	}

	// analytics: inactive, not synced
	if conns[0].Active || conns[0].Synced {
		t.Errorf("analytics should be inactive and unsynced; got active=%v synced=%v", conns[0].Active, conns[0].Synced)
	}
	// production: active, synced
	if !conns[1].Active || !conns[1].Synced {
		t.Errorf("production should be active and synced; got active=%v synced=%v", conns[1].Active, conns[1].Synced)
	}
	// staging: inactive, synced
	if conns[2].Active || !conns[2].Synced {
		t.Errorf("staging should be inactive and synced; got active=%v synced=%v", conns[2].Active, conns[2].Synced)
	}
}

// ── TestServer_HandleListTables ───────────────────────────────────────────────

func TestServer_HandleListTables_DefaultConn(t *testing.T) {
	srv := newTestServer(t)
	// No "connection" param → should use active connection (production)
	result := callTool(t, srv, "heydb_list_tables", map[string]any{})

	if result.IsError {
		t.Fatalf("heydb_list_tables (default conn) returned error: %s", firstText(t, result))
	}

	text := firstText(t, result)
	// Production has "users" and "orders"
	if !strings.Contains(text, "users") {
		t.Errorf("response does not contain 'users'; got: %s", text)
	}
	if !strings.Contains(text, "orders") {
		t.Errorf("response does not contain 'orders'; got: %s", text)
	}
	// Staging's table should NOT appear
	if strings.Contains(text, "products") {
		t.Errorf("response should not contain 'products' from staging; got: %s", text)
	}
}

func TestServer_HandleListTables_FilterByName(t *testing.T) {
	srv := newTestServer(t)
	// filter: "user" → should only return tables matching "user"
	result := callTool(t, srv, "heydb_list_tables", map[string]any{
		"filter": "user",
	})

	if result.IsError {
		t.Fatalf("heydb_list_tables (filter) returned error: %s", firstText(t, result))
	}

	text := firstText(t, result)
	if !strings.Contains(text, "users") {
		t.Errorf("expected 'users' in filtered response; got: %s", text)
	}
	// "orders" should NOT appear — doesn't match "user"
	if strings.Contains(text, "orders") {
		t.Errorf("filtered response should not contain 'orders'; got: %s", text)
	}
}

func TestServer_HandleListTables_FilterNoMatch(t *testing.T) {
	srv := newTestServer(t)
	result := callTool(t, srv, "heydb_list_tables", map[string]any{
		"filter": "nonexistent",
	})

	if result.IsError {
		t.Fatalf("heydb_list_tables (filter no match) returned error: %s", firstText(t, result))
	}

	text := firstText(t, result)
	// Should return an empty array
	var entries []json.RawMessage
	if err := json.Unmarshal([]byte(text), &entries); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(entries) != 0 {
		t.Errorf("expected 0 entries for non-matching filter; got %d", len(entries))
	}
}

func TestServer_HandleListTables_FilterCaseInsensitive(t *testing.T) {
	srv := newTestServer(t)
	result := callTool(t, srv, "heydb_list_tables", map[string]any{
		"filter": "USER",
	})

	if result.IsError {
		t.Fatalf("heydb_list_tables (filter case) returned error: %s", firstText(t, result))
	}

	text := firstText(t, result)
	if !strings.Contains(text, "users") {
		t.Errorf("case-insensitive filter should match 'users'; got: %s", text)
	}
}

func TestServer_HandleListTables_FilterEmpty(t *testing.T) {
	srv := newTestServer(t)
	// Empty filter → same as no filter, return all
	result := callTool(t, srv, "heydb_list_tables", map[string]any{
		"filter": "",
	})

	if result.IsError {
		t.Fatalf("heydb_list_tables (empty filter) returned error: %s", firstText(t, result))
	}

	text := firstText(t, result)
	if !strings.Contains(text, "users") || !strings.Contains(text, "orders") {
		t.Errorf("empty filter should return all tables; got: %s", text)
	}
}

func TestServer_HandleListTables_NamedConn(t *testing.T) {
	srv := newTestServer(t)
	// connection: "staging" → routes to staging schema
	result := callTool(t, srv, "heydb_list_tables", map[string]any{
		"connection": "staging",
	})

	if result.IsError {
		t.Fatalf("heydb_list_tables (staging) returned error: %s", firstText(t, result))
	}

	text := firstText(t, result)
	if !strings.Contains(text, "products") {
		t.Errorf("expected 'products' in staging response; got: %s", text)
	}
	// Production tables should NOT appear
	if strings.Contains(text, "users") || strings.Contains(text, "orders") {
		t.Errorf("staging response should not contain production tables; got: %s", text)
	}
}

func TestServer_HandleListTables_UnknownConn(t *testing.T) {
	srv := newTestServer(t)
	result := callTool(t, srv, "heydb_list_tables", map[string]any{
		"connection": "typo",
	})

	if !result.IsError {
		t.Fatalf("expected error for unknown connection; got: %s", firstText(t, result))
	}

	text := firstText(t, result)
	if !strings.Contains(text, "unknown connection") {
		t.Errorf("error should mention 'unknown connection'; got: %s", text)
	}
	// Error message must list available connections
	if !strings.Contains(text, "analytics") || !strings.Contains(text, "production") {
		t.Errorf("error should list available connection names; got: %s", text)
	}
}

func TestServer_HandleListTables_UnsyncedConn(t *testing.T) {
	srv := newTestServer(t)
	result := callTool(t, srv, "heydb_list_tables", map[string]any{
		"connection": "analytics",
	})

	if !result.IsError {
		t.Fatalf("expected error for unsynced connection; got: %s", firstText(t, result))
	}

	text := firstText(t, result)
	if !strings.Contains(text, "not synced") {
		t.Errorf("error should mention 'not synced'; got: %s", text)
	}
	if !strings.Contains(text, "heydb sync") {
		t.Errorf("error should instruct user to run heydb sync; got: %s", text)
	}
}

// ── TestServer_HandleGetTable ─────────────────────────────────────────────────

func TestServer_HandleGetTable_ConnectionRouting(t *testing.T) {
	srv := newTestServer(t)
	// "products" exists in staging, not in production
	result := callTool(t, srv, "heydb_get_table", map[string]any{
		"table_name": "products",
		"connection": "staging",
	})

	if result.IsError {
		t.Fatalf("heydb_get_table (staging/products) returned error: %s", firstText(t, result))
	}

	text := firstText(t, result)
	if !strings.Contains(text, "products") {
		t.Errorf("expected 'products' in response; got: %s", text)
	}
}

func TestServer_HandleGetTable_NotFoundInNamedConn(t *testing.T) {
	srv := newTestServer(t)
	// "users" exists in production but not staging
	result := callTool(t, srv, "heydb_get_table", map[string]any{
		"table_name": "users",
		"connection": "staging",
	})

	if !result.IsError {
		t.Fatalf("expected not-found error; got: %s", firstText(t, result))
	}
}

// ── TestServer_HandleAnnotate (v2 accumulative) ───────────────────────────────

func TestAnnotate_ReturnsUUID(t *testing.T) {
	srv := newTestServer(t)
	result := callTool(t, srv, "heydb_annotate", map[string]any{
		"table_name": "users",
		"annotation": "User accounts",
		"connection": "production",
	})

	if result.IsError {
		t.Fatalf("heydb_annotate returned error: %s", firstText(t, result))
	}

	text := firstText(t, result)
	var ann map[string]any
	if err := json.Unmarshal([]byte(text), &ann); err != nil {
		t.Fatalf("expected JSON response, unmarshal failed: %v\nraw: %s", err, text)
	}
	if id, _ := ann["id"].(string); id == "" {
		t.Errorf("expected non-empty id in response; got: %s", text)
	}
}

func TestAnnotate_AccumulatesMultiple(t *testing.T) {
	srv := newTestServer(t)

	// Two annotations on the same table.
	callTool(t, srv, "heydb_annotate", map[string]any{
		"table_name": "users",
		"annotation": "First note",
		"connection": "production",
	})
	callTool(t, srv, "heydb_annotate", map[string]any{
		"table_name": "users",
		"annotation": "Second note",
		"connection": "production",
	})

	// Verify get_table includes both annotations.
	result := callTool(t, srv, "heydb_get_table", map[string]any{
		"table_name": "users",
		"connection": "production",
	})
	if result.IsError {
		t.Fatalf("heydb_get_table returned error: %s", firstText(t, result))
	}

	text := firstText(t, result)
	var detail map[string]any
	if err := json.Unmarshal([]byte(text), &detail); err != nil {
		t.Fatalf("unmarshal get_table response: %v", err)
	}
	anns, ok := detail["annotations"].([]any)
	if !ok {
		t.Fatalf("expected 'annotations' array in response; got: %s", text)
	}
	if len(anns) != 2 {
		t.Errorf("expected 2 annotations after two annotate calls, got %d", len(anns))
	}
}

func TestGetTable_AnnotationsIsArray(t *testing.T) {
	srv := newTestServer(t)
	result := callTool(t, srv, "heydb_get_table", map[string]any{
		"table_name": "users",
		"connection": "production",
	})

	if result.IsError {
		t.Fatalf("heydb_get_table returned error: %s", firstText(t, result))
	}

	text := firstText(t, result)
	var detail map[string]any
	if err := json.Unmarshal([]byte(text), &detail); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	// annotations must be an array (never null), even when empty.
	raw, exists := detail["annotations"]
	if !exists {
		t.Fatalf("'annotations' field missing from response; got: %s", text)
	}
	if _, ok := raw.([]any); !ok {
		t.Errorf("'annotations' must be an array, got %T; response: %s", raw, text)
	}
}

func TestEditAnnotation_UpdatesContent(t *testing.T) {
	srv := newTestServer(t)

	// First annotate.
	r := callTool(t, srv, "heydb_annotate", map[string]any{
		"table_name": "users",
		"annotation": "original",
		"connection": "production",
	})
	if r.IsError {
		t.Fatalf("annotate: %s", firstText(t, r))
	}
	var created map[string]any
	if err := json.Unmarshal([]byte(firstText(t, r)), &created); err != nil {
		t.Fatalf("unmarshal annotate response: %v", err)
	}
	id, _ := created["id"].(string)

	// Then edit.
	editResult := callTool(t, srv, "heydb_edit_annotation", map[string]any{
		"id":      id,
		"content": "updated content",
	})
	if editResult.IsError {
		t.Fatalf("heydb_edit_annotation returned error: %s", firstText(t, editResult))
	}

	text := firstText(t, editResult)
	var updated map[string]any
	if err := json.Unmarshal([]byte(text), &updated); err != nil {
		t.Fatalf("unmarshal edit response: %v", err)
	}
	if content, _ := updated["content"].(string); content != "updated content" {
		t.Errorf("content: got %q, want %q", content, "updated content")
	}
}

func TestEditAnnotation_NotFound(t *testing.T) {
	srv := newTestServer(t)
	result := callTool(t, srv, "heydb_edit_annotation", map[string]any{
		"id":      "nonexistent-uuid",
		"content": "whatever",
	})

	if !result.IsError {
		t.Fatalf("expected error for nonexistent annotation; got: %s", firstText(t, result))
	}
}

func TestDeleteAnnotation_RemovesFromGet(t *testing.T) {
	srv := newTestServer(t)

	// Annotate.
	r := callTool(t, srv, "heydb_annotate", map[string]any{
		"table_name": "users",
		"annotation": "to be deleted",
		"connection": "production",
	})
	if r.IsError {
		t.Fatalf("annotate: %s", firstText(t, r))
	}
	var created map[string]any
	if err := json.Unmarshal([]byte(firstText(t, r)), &created); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	id, _ := created["id"].(string)

	// Delete.
	del := callTool(t, srv, "heydb_delete_annotation", map[string]any{"id": id})
	if del.IsError {
		t.Fatalf("heydb_delete_annotation returned error: %s", firstText(t, del))
	}

	// Verify get_table shows empty annotations.
	result := callTool(t, srv, "heydb_get_table", map[string]any{
		"table_name": "users",
		"connection": "production",
	})
	var detail map[string]any
	if err := json.Unmarshal([]byte(firstText(t, result)), &detail); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	anns, _ := detail["annotations"].([]any)
	if len(anns) != 0 {
		t.Errorf("expected 0 annotations after delete, got %d", len(anns))
	}
}

func TestDeleteAnnotation_NotFound(t *testing.T) {
	srv := newTestServer(t)
	result := callTool(t, srv, "heydb_delete_annotation", map[string]any{
		"id": "nonexistent-uuid",
	})

	if !result.IsError {
		t.Fatalf("expected error for nonexistent annotation; got: %s", firstText(t, result))
	}
}

// ── TestServer_BackwardCompat ─────────────────────────────────────────────────

func TestServer_BackwardCompat_NoConnectionParam(t *testing.T) {
	// Single-connection registry (backward compat scenario)
	entry := &mcp.ConnEntry{
		Schema: &mockSchemaStore{tables: []schema.Table{
			{Name: "users", Columns: []schema.Column{{Name: "id"}}},
		}},
		Annotations: &mockAnnotationStore{},
	}
	reg := mcp.NewRegistry(
		map[string]*mcp.ConnEntry{"main": entry},
		[]string{"main"},
		"main",
	)
	srv := mcp.New(reg)

	// Call with NO connection param — must route to "main" transparently
	result := callTool(t, srv, "heydb_list_tables", map[string]any{})

	if result.IsError {
		t.Fatalf("backward compat: heydb_list_tables returned error: %s", firstText(t, result))
	}
	text := firstText(t, result)
	if !strings.Contains(text, "users") {
		t.Errorf("backward compat: expected 'users' in response; got: %s", text)
	}
}

func TestServer_BackwardCompat_NewSingle(t *testing.T) {
	// NewSingle must still work for serve.go PR-1 compatibility
	store := &mockSchemaStore{tables: []schema.Table{
		{Name: "accounts", Columns: []schema.Column{{Name: "id"}}},
	}}
	ann := &mockAnnotationStore{}

	srv := mcp.NewSingle(store, ann)
	result := callTool(t, srv, "heydb_list_tables", map[string]any{})

	if result.IsError {
		t.Fatalf("NewSingle: heydb_list_tables returned error: %s", firstText(t, result))
	}
	text := firstText(t, result)
	if !strings.Contains(text, "accounts") {
		t.Errorf("NewSingle: expected 'accounts' in response; got: %s", text)
	}
}

// ── TestServer_AddRelationship (T-08) ─────────────────────────────────────────

func TestAddRelationship_ReturnsCreatedObject(t *testing.T) {
	srv := newTestServer(t)
	result := callTool(t, srv, "heydb_add_relationship", map[string]any{
		"from_table":  "orders",
		"from_column": "user_id",
		"to_table":    "users",
		"to_column":   "id",
		"connection":  "production",
	})

	if result.IsError {
		t.Fatalf("heydb_add_relationship returned error: %s", firstText(t, result))
	}

	text := firstText(t, result)
	var rel map[string]any
	if err := json.Unmarshal([]byte(text), &rel); err != nil {
		t.Fatalf("unmarshal response: %v\nraw: %s", err, text)
	}
	if id, _ := rel["id"].(string); id == "" {
		t.Errorf("expected non-empty id; got: %s", text)
	}
	if v, _ := rel["from_table"].(string); v != "orders" {
		t.Errorf("from_table: want 'orders', got %q", v)
	}
	if v, _ := rel["to_table"].(string); v != "users" {
		t.Errorf("to_table: want 'users', got %q", v)
	}
}

func TestAddRelationship_TableNotFound(t *testing.T) {
	srv := newTestServer(t)
	result := callTool(t, srv, "heydb_add_relationship", map[string]any{
		"from_table":  "ghost_table",
		"from_column": "id",
		"to_table":    "users",
		"to_column":   "id",
		"connection":  "production",
	})

	if !result.IsError {
		t.Fatalf("expected error for unknown table; got: %s", firstText(t, result))
	}
}

func TestAddRelationship_ColumnNotFound(t *testing.T) {
	srv := newTestServer(t)
	result := callTool(t, srv, "heydb_add_relationship", map[string]any{
		"from_table":  "orders",
		"from_column": "ghost_column",
		"to_table":    "users",
		"to_column":   "id",
		"connection":  "production",
	})

	if !result.IsError {
		t.Fatalf("expected error for unknown column; got: %s", firstText(t, result))
	}
}

func TestAddRelationship_MissingFromTable(t *testing.T) {
	srv := newTestServer(t)
	result := callTool(t, srv, "heydb_add_relationship", map[string]any{
		"from_column": "user_id",
		"to_table":    "users",
		"to_column":   "id",
	})

	if !result.IsError {
		t.Fatalf("expected error when from_table missing; got: %s", firstText(t, result))
	}
}

// ── TestServer_DeleteRelationship (T-08) ─────────────────────────────────────

func TestDeleteRelationship_Success(t *testing.T) {
	srv := newTestServer(t)

	// Add first.
	r := callTool(t, srv, "heydb_add_relationship", map[string]any{
		"from_table":  "orders",
		"from_column": "user_id",
		"to_table":    "users",
		"to_column":   "id",
		"connection":  "production",
	})
	if r.IsError {
		t.Fatalf("add_relationship: %s", firstText(t, r))
	}
	var created map[string]any
	if err := json.Unmarshal([]byte(firstText(t, r)), &created); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	id, _ := created["id"].(string)

	// Delete.
	del := callTool(t, srv, "heydb_delete_relationship", map[string]any{
		"id":         id,
		"connection": "production",
	})
	if del.IsError {
		t.Fatalf("heydb_delete_relationship returned error: %s", firstText(t, del))
	}

	text := firstText(t, del)
	var resp map[string]any
	if err := json.Unmarshal([]byte(text), &resp); err != nil {
		t.Fatalf("unmarshal delete response: %v", err)
	}
	if deleted, _ := resp["deleted"].(bool); !deleted {
		t.Errorf("expected deleted:true; got: %s", text)
	}
}

func TestDeleteRelationship_NotFound(t *testing.T) {
	srv := newTestServer(t)
	result := callTool(t, srv, "heydb_delete_relationship", map[string]any{
		"id": "nonexistent-uuid",
	})

	if !result.IsError {
		t.Fatalf("expected error for nonexistent relationship; got: %s", firstText(t, result))
	}
}

// ── TestServer_ListRelationships (T-08/T-09) ──────────────────────────────────

func TestListRelationships_EmptyWhenNone(t *testing.T) {
	srv := newTestServer(t)
	result := callTool(t, srv, "heydb_list_relationships", map[string]any{
		"connection": "production",
	})

	if result.IsError {
		t.Fatalf("heydb_list_relationships returned error: %s", firstText(t, result))
	}

	text := firstText(t, result)
	var rels []json.RawMessage
	if err := json.Unmarshal([]byte(text), &rels); err != nil {
		t.Fatalf("unmarshal: %v\nraw: %s", err, text)
	}
	if len(rels) != 0 {
		t.Errorf("expected 0 relationships; got %d", len(rels))
	}
}

func TestListRelationships_ReturnsAdded(t *testing.T) {
	srv := newTestServer(t)

	callTool(t, srv, "heydb_add_relationship", map[string]any{
		"from_table":  "orders",
		"from_column": "user_id",
		"to_table":    "users",
		"to_column":   "id",
		"connection":  "production",
	})

	result := callTool(t, srv, "heydb_list_relationships", map[string]any{
		"connection": "production",
	})
	if result.IsError {
		t.Fatalf("heydb_list_relationships returned error: %s", firstText(t, result))
	}

	text := firstText(t, result)
	var rels []map[string]any
	if err := json.Unmarshal([]byte(text), &rels); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(rels) != 1 {
		t.Errorf("expected 1 relationship; got %d", len(rels))
	}
}

// ── TestServer_GetTable_MergesImplicitFKs (T-10) ──────────────────────────────

func TestGetTable_MergesImplicitFKs(t *testing.T) {
	// Build a server where "users" table has a native FK and an implicit rel.
	relStore := &mockRelationshipStore{}
	production := &mcp.ConnEntry{
		Schema: &mockSchemaStore{tables: []schema.Table{
			{
				Name:    "orders",
				Columns: []schema.Column{{Name: "id"}, {Name: "user_id"}},
				ForeignKeys: []schema.ForeignKey{
					{Name: "fk_orders_payment", Column: "payment_id", ReferencedTable: "payments", ReferencedColumn: "id"},
				},
			},
			{Name: "users", Columns: []schema.Column{{Name: "id"}}},
			{Name: "payments", Columns: []schema.Column{{Name: "id"}}},
		}},
		Annotations:   &mockAnnotationStore{},
		Relationships: relStore,
	}
	reg := mcp.NewRegistry(
		map[string]*mcp.ConnEntry{"production": production},
		[]string{"production"},
		"production",
	)
	srv := mcp.NewWithMeta(reg, testProjectID, "test-author")

	// Add an implicit relationship: orders.user_id → users.id
	callTool(t, srv, "heydb_add_relationship", map[string]any{
		"from_table":  "orders",
		"from_column": "user_id",
		"to_table":    "users",
		"to_column":   "id",
		"connection":  "production",
	})

	// get_table for "orders" should return 2 FKs: 1 native + 1 implicit.
	result := callTool(t, srv, "heydb_get_table", map[string]any{
		"table_name": "orders",
		"connection": "production",
	})
	if result.IsError {
		t.Fatalf("heydb_get_table returned error: %s", firstText(t, result))
	}

	text := firstText(t, result)
	var detail map[string]any
	if err := json.Unmarshal([]byte(text), &detail); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	fks, ok := detail["foreign_keys"].([]any)
	if !ok {
		t.Fatalf("expected foreign_keys array; got: %s", text)
	}
	if len(fks) != 2 {
		t.Errorf("expected 2 foreign keys (1 native + 1 implicit); got %d: %s", len(fks), text)
	}

	// Verify the implicit FK has implicit:true.
	foundImplicit := false
	for _, rawFK := range fks {
		fk, _ := rawFK.(map[string]any)
		if imp, _ := fk["implicit"].(bool); imp {
			foundImplicit = true
			if v, _ := fk["referenced_table"].(string); v != "users" {
				t.Errorf("implicit FK referenced_table: want 'users', got %q", v)
			}
		}
	}
	if !foundImplicit {
		t.Errorf("no implicit FK found in response: %s", text)
	}
}

func TestGetTable_OnlyImplicitFKs(t *testing.T) {
	// Table with no native FKs but one implicit relationship.
	relStore := &mockRelationshipStore{}
	production := &mcp.ConnEntry{
		Schema: &mockSchemaStore{tables: []schema.Table{
			{Name: "orders", Columns: []schema.Column{{Name: "id"}, {Name: "user_id"}}},
			{Name: "users", Columns: []schema.Column{{Name: "id"}}},
		}},
		Annotations:   &mockAnnotationStore{},
		Relationships: relStore,
	}
	reg := mcp.NewRegistry(
		map[string]*mcp.ConnEntry{"production": production},
		[]string{"production"},
		"production",
	)
	srv := mcp.NewWithMeta(reg, testProjectID, "test-author")

	callTool(t, srv, "heydb_add_relationship", map[string]any{
		"from_table":  "orders",
		"from_column": "user_id",
		"to_table":    "users",
		"to_column":   "id",
		"connection":  "production",
	})

	result := callTool(t, srv, "heydb_get_table", map[string]any{
		"table_name": "orders",
		"connection": "production",
	})
	if result.IsError {
		t.Fatalf("heydb_get_table returned error: %s", firstText(t, result))
	}

	text := firstText(t, result)
	var detail map[string]any
	if err := json.Unmarshal([]byte(text), &detail); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	fks, ok := detail["foreign_keys"].([]any)
	if !ok {
		// foreign_keys might be absent when empty — check it's not present or has 1 item.
		// The implicit rel should still be there.
		if strings.Contains(text, "implicit") {
			return // good — implicit FK present
		}
		t.Fatalf("expected foreign_keys with implicit entry; got: %s", text)
	}
	if len(fks) != 1 {
		t.Errorf("expected 1 FK (implicit only); got %d: %s", len(fks), text)
	}
	fk, _ := fks[0].(map[string]any)
	if imp, _ := fk["implicit"].(bool); !imp {
		t.Errorf("expected implicit:true for the only FK; got: %s", text)
	}
}

// ── TestServer_HandleSearch_MatchSource (T-10) ────────────────────────────────

func TestSearch_MatchSource_Schema(t *testing.T) {
	srv := newTestServer(t)
	result := callTool(t, srv, "heydb_search", map[string]any{
		"query":      "users",
		"connection": "production",
	})
	if result.IsError {
		t.Fatalf("heydb_search returned error: %s", firstText(t, result))
	}

	text := firstText(t, result)
	var entries []map[string]any
	if err := json.Unmarshal([]byte(text), &entries); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(entries) == 0 {
		t.Fatalf("expected at least one result; got: %s", text)
	}
	// The "users" result matched by schema name — match_source should be set.
	found := false
	for _, e := range entries {
		if e["name"] == "users" {
			found = true
			if src, _ := e["match_source"].(string); src == "" {
				t.Errorf("expected non-empty match_source for 'users'; got: %s", text)
			}
		}
	}
	if !found {
		t.Errorf("'users' not found in search results: %s", text)
	}
}

func TestSearch_MatchSource_Annotation(t *testing.T) {
	// Seed an annotation on "orders" containing "facturación" — then search
	// for "facturación". The table should appear with match_source "annotation".
	annStore := &mockAnnotationStore{
		annotations: []schema.Annotation{
			{
				ID:             "ann-1",
				ProjectID:      testProjectID,
				ConnectionName: "production",
				TargetType:     "table",
				TargetName:     "orders",
				Content:        "Tabla principal de facturación",
				Author:         "test",
			},
		},
	}

	production := &mcp.ConnEntry{
		Schema: &mockSchemaStore{tables: []schema.Table{
			{Name: "users", Columns: []schema.Column{{Name: "id"}, {Name: "email"}}},
			{Name: "orders", Columns: []schema.Column{{Name: "id"}, {Name: "total"}, {Name: "user_id"}}},
		}},
		Annotations:   annStore,
		Relationships: &mockRelationshipStore{},
	}

	reg := mcp.NewRegistry(
		map[string]*mcp.ConnEntry{"production": production},
		[]string{"production"},
		"production",
	)
	srv := mcp.NewWithMeta(reg, testProjectID, "test-author")

	result := callTool(t, srv, "heydb_search", map[string]any{
		"query":      "facturación",
		"connection": "production",
	})
	if result.IsError {
		t.Fatalf("heydb_search returned error: %s", firstText(t, result))
	}

	text := firstText(t, result)
	var entries []map[string]any
	if err := json.Unmarshal([]byte(text), &entries); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	found := false
	for _, e := range entries {
		if e["name"] == "orders" {
			found = true
			if src, _ := e["match_source"].(string); src != "annotation" {
				t.Errorf("expected match_source 'annotation' for 'orders'; got %q", src)
			}
		}
	}
	if !found {
		t.Errorf("'orders' not found in search results: %s", text)
	}
}

func TestSearch_MatchSource_Relationship(t *testing.T) {
	// Seed a relationship referencing "orders" — then search for "licencia".
	// The table referenced via the relationship label should appear.
	relStore := &mockRelationshipStore{
		relationships: []schema.ImplicitRelationship{
			{
				ID:             "rel-1",
				ProjectID:      testProjectID,
				ConnectionName: "production",
				FromTable:      "orders",
				FromColumn:     "id_licencia",
				ToTable:        "licencias",
				ToColumn:       "id",
				Label:          "licencia del pedido",
				Author:         "test",
			},
		},
	}

	production := &mcp.ConnEntry{
		Schema: &mockSchemaStore{tables: []schema.Table{
			{Name: "users", Columns: []schema.Column{{Name: "id"}, {Name: "email"}}},
			{Name: "orders", Columns: []schema.Column{{Name: "id"}, {Name: "total"}, {Name: "user_id"}}},
			{Name: "licencias", Columns: []schema.Column{{Name: "id"}, {Name: "codigo"}}},
		}},
		Annotations:   &mockAnnotationStore{},
		Relationships: relStore,
	}

	reg := mcp.NewRegistry(
		map[string]*mcp.ConnEntry{"production": production},
		[]string{"production"},
		"production",
	)
	srv := mcp.NewWithMeta(reg, testProjectID, "test-author")

	result := callTool(t, srv, "heydb_search", map[string]any{
		"query":      "licencia",
		"connection": "production",
	})
	if result.IsError {
		t.Fatalf("heydb_search returned error: %s", firstText(t, result))
	}

	text := firstText(t, result)
	var entries []map[string]any
	if err := json.Unmarshal([]byte(text), &entries); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	// "orders" should match via relationship (from_column "id_licencia" contains "licencia")
	foundOrders := false
	for _, e := range entries {
		if e["name"] == "orders" {
			foundOrders = true
			if src, _ := e["match_source"].(string); src != "relationship" {
				t.Errorf("expected match_source 'relationship' for 'orders'; got %q", src)
			}
		}
	}
	if !foundOrders {
		t.Errorf("'orders' not found in search results: %s", text)
	}

	// "licencias" should match by table_name
	foundLicencias := false
	for _, e := range entries {
		if e["name"] == "licencias" {
			foundLicencias = true
			if src, _ := e["match_source"].(string); src != "table_name" {
				t.Errorf("expected match_source 'table_name' for 'licencias'; got %q", src)
			}
		}
	}
	if !foundLicencias {
		t.Errorf("'licencias' not found in search results: %s", text)
	}
}
