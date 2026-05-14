// Package mcp provides a thin wrapper around mark3labs/mcp-go that exposes
// three tools for querying the heydb schema store:
//
//   - heydb_list_tables   — list all tables with column counts
//   - heydb_get_table     — return full detail for one table
//   - heydb_search        — substring search across table/column names
//
// The server reads from a SchemaStore (backed by SQLite) exclusively. It
// never opens a connection to the source MySQL database.
package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	mcpgo "github.com/mark3labs/mcp-go/mcp"
	mcpserver "github.com/mark3labs/mcp-go/server"

	"github.com/pvidaal07/heydb/internal/domain/ports"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// Server wraps an MCPServer and a SchemaStore.
type Server struct {
	store ports.SchemaStore
	srv   *mcpserver.MCPServer
}

// New creates a new Server backed by the provided SchemaStore.
// Call Serve() to start listening on stdio.
func New(store ports.SchemaStore) *Server {
	s := &Server{store: store}
	s.srv = mcpserver.NewMCPServer("heydb", "0.1.0")
	s.registerTools()
	return s
}

// Serve starts the MCP server on stdio (blocking). A startup line is logged to
// stderr so it does not corrupt the MCP JSON-RPC protocol on stdout.
func (s *Server) Serve() error {
	fmt.Fprintln(os.Stderr, "heydb MCP server started — listening on stdio")
	return mcpserver.ServeStdio(s.srv)
}

// registerTools wires the three heydb tools into the MCPServer.
func (s *Server) registerTools() {
	// ── heydb_list_tables ────────────────────────────────────────────────────
	s.srv.AddTool(
		mcpgo.NewTool(
			"heydb_list_tables",
			mcpgo.WithDescription("List all tables in the documented database schema, with column counts and comments."),
		),
		s.handleListTables,
	)

	// ── heydb_get_table ──────────────────────────────────────────────────────
	s.srv.AddTool(
		mcpgo.NewTool(
			"heydb_get_table",
			mcpgo.WithDescription("Get full schema detail for a specific table (columns, indexes, foreign keys)."),
			mcpgo.WithString("table_name",
				mcpgo.Description("Name of the table to retrieve."),
				mcpgo.Required(),
			),
		),
		s.handleGetTable,
	)

	// ── heydb_search ─────────────────────────────────────────────────────────
	s.srv.AddTool(
		mcpgo.NewTool(
			"heydb_search",
			mcpgo.WithDescription("Search tables and columns by keyword (case-insensitive substring match on names and comments)."),
			mcpgo.WithString("query",
				mcpgo.Description("Search term to match against table names, column names, and comments."),
				mcpgo.Required(),
			),
		),
		s.handleSearch,
	)
}

// ── tool handlers ─────────────────────────────────────────────────────────────

// tableListEntry is the response shape for heydb_list_tables.
type tableListEntry struct {
	Name        string `json:"name"`
	ColumnCount int    `json:"column_count"`
	Comment     string `json:"comment,omitempty"`
}

func (s *Server) handleListTables(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
	sc, err := s.store.LoadSchema(ctx)
	if err != nil {
		return mcpgo.NewToolResultError(fmt.Sprintf("failed to load schema: %v", err)), nil
	}

	entries := make([]tableListEntry, 0, len(sc.Tables))
	for _, t := range sc.Tables {
		entries = append(entries, tableListEntry{
			Name:        t.Name,
			ColumnCount: len(t.Columns),
			Comment:     t.Comment,
		})
	}

	return jsonResult(entries)
}

// columnDetail is the response shape for a single column in heydb_get_table.
type columnDetail struct {
	Name     string  `json:"name"`
	Type     string  `json:"type"`
	Nullable bool    `json:"nullable"`
	Default  *string `json:"default,omitempty"`
	Key      string  `json:"key,omitempty"`
	Extra    string  `json:"extra,omitempty"`
	Comment  string  `json:"comment,omitempty"`
}

// indexDetail is the response shape for a single index.
type indexDetail struct {
	Name    string   `json:"name"`
	Columns []string `json:"columns"`
	Unique  bool     `json:"unique"`
	Type    string   `json:"type,omitempty"`
}

// fkDetail is the response shape for a single foreign key.
type fkDetail struct {
	Name             string `json:"name"`
	Column           string `json:"column"`
	ReferencedTable  string `json:"referenced_table"`
	ReferencedColumn string `json:"referenced_column"`
}

// tableDetail is the full response shape for heydb_get_table.
type tableDetail struct {
	Name        string        `json:"name"`
	Engine      string        `json:"engine,omitempty"`
	Comment     string        `json:"comment,omitempty"`
	PrimaryKey  []string      `json:"primary_key,omitempty"`
	Columns     []columnDetail `json:"columns"`
	Indexes     []indexDetail  `json:"indexes,omitempty"`
	ForeignKeys []fkDetail     `json:"foreign_keys,omitempty"`
}

func (s *Server) handleGetTable(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
	tableName, _ := req.GetArguments()["table_name"].(string)
	if tableName == "" {
		return mcpgo.NewToolResultError("table_name argument is required"), nil
	}

	t, err := s.store.GetTable(ctx, tableName)
	if err != nil {
		// Return an MCP error that lists available table names.
		names, listErr := s.allTableNames(ctx)
		if listErr != nil {
			return mcpgo.NewToolResultError(
				fmt.Sprintf("table %q not found", tableName),
			), nil
		}
		return mcpgo.NewToolResultError(
			fmt.Sprintf("table %q not found. Available tables: %s",
				tableName, strings.Join(names, ", ")),
		), nil
	}

	return jsonResult(tableToDetail(t))
}

func (s *Server) handleSearch(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
	query, _ := req.GetArguments()["query"].(string)
	if query == "" {
		return mcpgo.NewToolResultError("query argument is required"), nil
	}

	tables, err := s.store.SearchTables(ctx, query)
	if err != nil {
		return mcpgo.NewToolResultError(fmt.Sprintf("search failed: %v", err)), nil
	}

	entries := make([]tableListEntry, 0, len(tables))
	for _, t := range tables {
		entries = append(entries, tableListEntry{
			Name:        t.Name,
			ColumnCount: len(t.Columns),
			Comment:     t.Comment,
		})
	}

	return jsonResult(entries)
}

// ── helpers ──────────────────────────────────────────────────────────────────

// allTableNames returns a sorted list of all table names from the schema store.
func (s *Server) allTableNames(ctx context.Context) ([]string, error) {
	sc, err := s.store.LoadSchema(ctx)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(sc.Tables))
	for _, t := range sc.Tables {
		names = append(names, t.Name)
	}
	return names, nil
}

// tableToDetail converts a domain schema.Table to the wire response struct.
func tableToDetail(t schema.Table) tableDetail {
	cols := make([]columnDetail, 0, len(t.Columns))
	for _, c := range t.Columns {
		cols = append(cols, columnDetail{
			Name:     c.Name,
			Type:     c.Type,
			Nullable: c.Nullable,
			Default:  c.Default,
			Key:      c.Key,
			Extra:    c.Extra,
			Comment:  c.Comment,
		})
	}

	idxs := make([]indexDetail, 0, len(t.Indexes))
	for _, i := range t.Indexes {
		idxs = append(idxs, indexDetail{
			Name:    i.Name,
			Columns: i.Columns,
			Unique:  i.Unique,
			Type:    i.Type,
		})
	}

	fks := make([]fkDetail, 0, len(t.ForeignKeys))
	for _, fk := range t.ForeignKeys {
		fks = append(fks, fkDetail{
			Name:             fk.Name,
			Column:           fk.Column,
			ReferencedTable:  fk.ReferencedTable,
			ReferencedColumn: fk.ReferencedColumn,
		})
	}

	return tableDetail{
		Name:        t.Name,
		Engine:      t.Engine,
		Comment:     t.Comment,
		PrimaryKey:  t.PrimaryKey,
		Columns:     cols,
		Indexes:     idxs,
		ForeignKeys: fks,
	}
}

// jsonResult marshals v to JSON and returns it as a text tool result.
func jsonResult(v any) (*mcpgo.CallToolResult, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return mcpgo.NewToolResultError(fmt.Sprintf("failed to serialize result: %v", err)), nil
	}
	return mcpgo.NewToolResultText(string(b)), nil
}
