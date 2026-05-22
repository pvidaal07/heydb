// Package mcp provides a thin wrapper around mark3labs/mcp-go that exposes
// tools for querying and annotating heydb connection schemas:
//
//   - heydb_list_connections    — list all configured connections with status
//   - heydb_list_tables         — list all tables with column counts and comments
//   - heydb_get_table           — return full detail for one table (incl. annotations + implicit FKs)
//   - heydb_search              — search across table/column names, annotations, and relationships
//   - heydb_annotate            — add a table-level annotation (accumulative)
//   - heydb_annotate_column     — add a column-level annotation (accumulative)
//   - heydb_annotate_db         — add a database-level annotation (accumulative)
//   - heydb_edit_annotation     — edit an annotation by UUID
//   - heydb_delete_annotation   — delete an annotation by UUID
//   - heydb_add_relationship    — add an implicit (undocumented) foreign-key relationship
//   - heydb_delete_relationship — delete an implicit relationship by UUID
//   - heydb_list_relationships  — list all implicit relationships for a connection
//
// All tools accept an optional "connection" parameter.
// When omitted, the active connection is used.
//
// The server reads from SQLite exclusively via a Registry of open store pairs.
// It never opens a connection to the source MySQL database.
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

// Server wraps an MCPServer and a connection Registry.
type Server struct {
	registry  *Registry
	srv       *mcpserver.MCPServer
	projectID string // used to scope annotation queries
	author    string // auto-populated author for new annotations
}

// New creates a new Server backed by the provided Registry.
// Call Serve() to start listening on stdio.
func New(registry *Registry) *Server {
	s := &Server{registry: registry}
	s.srv = mcpserver.NewMCPServer("heydb", "0.1.0")
	s.registerTools()
	return s
}

// NewWithMeta creates a Server with project metadata needed for accumulative annotations.
// projectID scopes annotation queries; author is auto-populated on new annotations.
func NewWithMeta(registry *Registry, projectID, author string) *Server {
	s := &Server{registry: registry, projectID: projectID, author: author}
	s.srv = mcpserver.NewMCPServer("heydb", "0.1.0")
	s.registerTools()
	return s
}

// NewSingle creates a Server from a single store pair, for backward
// compatibility with callers that have not yet migrated to Registry.
//
// Deprecated: use New(registry) instead. This wrapper will be removed in PR-5.
func NewSingle(store ports.SchemaStore, annotations ports.AnnotationStore) *Server {
	entry := &ConnEntry{Schema: store, Annotations: annotations}
	reg := NewRegistry(
		map[string]*ConnEntry{"default": entry},
		[]string{"default"},
		"default",
	)
	return New(reg)
}

// Serve starts the MCP server on stdio (blocking). A startup line is logged to
// stderr so it does not corrupt the MCP JSON-RPC protocol on stdout.
func (s *Server) Serve() error {
	fmt.Fprintln(os.Stderr, "heydb MCP server started — listening on stdio")
	return mcpserver.ServeStdio(s.srv)
}

// MCPServer returns the underlying MCPServer, for in-process testing.
func (s *Server) MCPServer() *mcpserver.MCPServer {
	return s.srv
}

// registerTools wires all heydb tools into the MCPServer.
func (s *Server) registerTools() {
	// ── heydb_list_connections ────────────────────────────────────────────────
	s.srv.AddTool(
		mcpgo.NewTool(
			"heydb_list_connections",
			mcpgo.WithDescription("List all configured database connections with their active and sync status."),
		),
		s.handleListConnections,
	)

	// ── heydb_list_tables ────────────────────────────────────────────────────
	s.srv.AddTool(
		mcpgo.NewTool(
			"heydb_list_tables",
			mcpgo.WithDescription("List tables in the documented database schema, with column counts and comments. For large schemas, use the filter parameter to narrow results and reduce response size."),
			mcpgo.WithString("filter",
				mcpgo.Description("Optional keyword to filter tables by name (case-insensitive substring match). Only tables whose name contains this keyword are returned."),
			),
			mcpgo.WithString("connection",
				mcpgo.Description("Optional connection name. Defaults to the active connection."),
			),
		),
		s.handleListTables,
	)

	// ── heydb_get_table ──────────────────────────────────────────────────────
	s.srv.AddTool(
		mcpgo.NewTool(
			"heydb_get_table",
			mcpgo.WithDescription("Get full schema detail for a specific table (columns, indexes, foreign keys, annotations)."),
			mcpgo.WithString("table_name",
				mcpgo.Description("Name of the table to retrieve."),
				mcpgo.Required(),
			),
			mcpgo.WithString("connection",
				mcpgo.Description("Optional connection name. Defaults to the active connection."),
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
			mcpgo.WithString("connection",
				mcpgo.Description("Optional connection name. Defaults to the active connection."),
			),
		),
		s.handleSearch,
	)

	// ── heydb_annotate ───────────────────────────────────────────────────────
	s.srv.AddTool(
		mcpgo.NewTool(
			"heydb_annotate",
			mcpgo.WithDescription("Add a human/AI annotation for a table. Annotations are accumulative — multiple annotations per table are allowed and tracked by UUID."),
			mcpgo.WithString("table_name",
				mcpgo.Description("Name of the table to annotate."),
				mcpgo.Required(),
			),
			mcpgo.WithString("annotation",
				mcpgo.Description("Free-form annotation text."),
				mcpgo.Required(),
			),
			mcpgo.WithString("connection",
				mcpgo.Description("Optional connection name. Defaults to the active connection."),
			),
		),
		s.handleAnnotate,
	)

	// ── heydb_annotate_column ───────────────────────────────────────────────
	s.srv.AddTool(
		mcpgo.NewTool(
			"heydb_annotate_column",
			mcpgo.WithDescription("Add an annotation for a specific column. Accumulative — multiple annotations per column are allowed."),
			mcpgo.WithString("table_name",
				mcpgo.Description("Name of the table containing the column."),
				mcpgo.Required(),
			),
			mcpgo.WithString("column_name",
				mcpgo.Description("Name of the column to annotate."),
				mcpgo.Required(),
			),
			mcpgo.WithString("annotation",
				mcpgo.Description("Free-form annotation text."),
				mcpgo.Required(),
			),
			mcpgo.WithString("connection",
				mcpgo.Description("Optional connection name. Defaults to the active connection."),
			),
		),
		s.handleAnnotateColumn,
	)

	// ── heydb_annotate_db ───────────────────────────────────────────────────
	s.srv.AddTool(
		mcpgo.NewTool(
			"heydb_annotate_db",
			mcpgo.WithDescription("Add a database-level annotation. Accumulative — multiple annotations are allowed."),
			mcpgo.WithString("annotation",
				mcpgo.Description("Free-form annotation text."),
				mcpgo.Required(),
			),
			mcpgo.WithString("connection",
				mcpgo.Description("Optional connection name. Defaults to the active connection."),
			),
		),
		s.handleAnnotateDB,
	)

	// ── heydb_edit_annotation ───────────────────────────────────────────────
	s.srv.AddTool(
		mcpgo.NewTool(
			"heydb_edit_annotation",
			mcpgo.WithDescription("Edit an existing annotation by its UUID. Updates the content and updated_at timestamp."),
			mcpgo.WithString("id",
				mcpgo.Description("UUID of the annotation to edit."),
				mcpgo.Required(),
			),
			mcpgo.WithString("content",
				mcpgo.Description("New annotation text to replace the existing content."),
				mcpgo.Required(),
			),
			mcpgo.WithString("connection",
				mcpgo.Description("Optional connection name hint (not used for lookup, annotation UUID is unique)."),
			),
		),
		s.handleEditAnnotation,
	)

	// ── heydb_delete_annotation ─────────────────────────────────────────────
	s.srv.AddTool(
		mcpgo.NewTool(
			"heydb_delete_annotation",
			mcpgo.WithDescription("Delete an annotation by its UUID."),
			mcpgo.WithString("id",
				mcpgo.Description("UUID of the annotation to delete."),
				mcpgo.Required(),
			),
			mcpgo.WithString("connection",
				mcpgo.Description("Optional connection name hint (not used for lookup, annotation UUID is unique)."),
			),
		),
		s.handleDeleteAnnotation,
	)

	// ── heydb_add_relationship ───────────────────────────────────────────────
	s.srv.AddTool(
		mcpgo.NewTool(
			"heydb_add_relationship",
			mcpgo.WithDescription("Document an implicit (undocumented) foreign-key relationship between two tables. Both tables and columns must exist in the schema."),
			mcpgo.WithString("from_table",
				mcpgo.Description("The child/many-side table name."),
				mcpgo.Required(),
			),
			mcpgo.WithString("from_column",
				mcpgo.Description("The column on from_table that references to_table."),
				mcpgo.Required(),
			),
			mcpgo.WithString("to_table",
				mcpgo.Description("The parent/one-side table name."),
				mcpgo.Required(),
			),
			mcpgo.WithString("to_column",
				mcpgo.Description("The column on to_table being referenced."),
				mcpgo.Required(),
			),
			mcpgo.WithString("label",
				mcpgo.Description("Optional human-readable description of the relationship."),
			),
			mcpgo.WithString("connection",
				mcpgo.Description("Optional connection name. Defaults to the active connection."),
			),
		),
		s.handleAddRelationship,
	)

	// ── heydb_delete_relationship ────────────────────────────────────────────
	s.srv.AddTool(
		mcpgo.NewTool(
			"heydb_delete_relationship",
			mcpgo.WithDescription("Delete an implicit relationship by its UUID."),
			mcpgo.WithString("id",
				mcpgo.Description("UUID of the implicit relationship to delete."),
				mcpgo.Required(),
			),
			mcpgo.WithString("connection",
				mcpgo.Description("Optional connection name. Defaults to the active connection."),
			),
		),
		s.handleDeleteRelationship,
	)

	// ── heydb_list_relationships ─────────────────────────────────────────────
	s.srv.AddTool(
		mcpgo.NewTool(
			"heydb_list_relationships",
			mcpgo.WithDescription("List all implicit relationships for the active or specified connection."),
			mcpgo.WithString("connection",
				mcpgo.Description("Optional connection name. Defaults to the active connection."),
			),
		),
		s.handleListRelationships,
	)
}

// ── connection resolution ─────────────────────────────────────────────────────

// resolveConnection extracts the optional "connection" argument and resolves it
// via the registry. Returns the ConnEntry, the resolved connection name, and any
// error. An empty or missing "connection" arg defaults to the active connection.
func (s *Server) resolveConnection(args map[string]any) (*ConnEntry, string, error) {
	connName, _ := args["connection"].(string)
	return s.registry.Resolve(connName)
}

// ── tool handlers ─────────────────────────────────────────────────────────────

func (s *Server) handleListConnections(_ context.Context, _ mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
	return jsonResult(s.registry.List())
}

// tableListEntry is the response shape for heydb_list_tables.
type tableListEntry struct {
	Name        string `json:"name"`
	ColumnCount int    `json:"column_count"`
	Comment     string `json:"comment,omitempty"`
}

func (s *Server) handleListTables(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
	args := req.GetArguments()
	entry, _, err := s.resolveConnection(args)
	if err != nil {
		return mcpgo.NewToolResultError(err.Error()), nil
	}

	sc, err := entry.Schema.LoadSchema(ctx)
	if err != nil {
		return mcpgo.NewToolResultError(fmt.Sprintf("failed to load schema: %v", err)), nil
	}

	filter, _ := args["filter"].(string)
	lowerFilter := strings.ToLower(filter)

	entries := make([]tableListEntry, 0, len(sc.Tables))
	for _, t := range sc.Tables {
		if lowerFilter != "" && !strings.Contains(strings.ToLower(t.Name), lowerFilter) {
			continue
		}
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
// Implicit is true for user-defined relationships that are not enforced by the DB engine.
type fkDetail struct {
	Name             string `json:"name"`
	Column           string `json:"column"`
	ReferencedTable  string `json:"referenced_table"`
	ReferencedColumn string `json:"referenced_column"`
	Implicit         bool   `json:"implicit"`
}

// annotationDetail is the wire shape for a single annotation in heydb_get_table.
type annotationDetail struct {
	ID        string `json:"id"`
	Author    string `json:"author,omitempty"`
	Content   string `json:"content"`
	CreatedAt string `json:"created_at,omitempty"`
}

// tableDetail is the full response shape for heydb_get_table.
type tableDetail struct {
	Name        string             `json:"name"`
	Engine      string             `json:"engine,omitempty"`
	Comment     string             `json:"comment,omitempty"`
	PrimaryKey  []string           `json:"primary_key,omitempty"`
	Columns     []columnDetail     `json:"columns"`
	Indexes     []indexDetail      `json:"indexes,omitempty"`
	ForeignKeys []fkDetail         `json:"foreign_keys,omitempty"`
	Annotations []annotationDetail `json:"annotations"`
}

func (s *Server) handleGetTable(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
	args := req.GetArguments()
	entry, connName, err := s.resolveConnection(args)
	if err != nil {
		return mcpgo.NewToolResultError(err.Error()), nil
	}

	tableName, _ := args["table_name"].(string)
	if tableName == "" {
		return mcpgo.NewToolResultError("table_name argument is required"), nil
	}

	t, err := entry.Schema.GetTable(ctx, tableName)
	if err != nil {
		names, listErr := allTableNames(ctx, entry)
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

	detail := tableToDetail(t)

	// Attach accumulative annotations if store is available.
	detail.Annotations = []annotationDetail{}
	if entry.Annotations != nil && s.projectID != "" {
		anns, err := entry.Annotations.GetAnnotations(ctx, s.projectID, connName, "table", tableName)
		if err == nil {
			for _, a := range anns {
				detail.Annotations = append(detail.Annotations, annotationDetail{
					ID:        a.ID,
					Author:    a.Author,
					Content:   a.Content,
					CreatedAt: a.CreatedAt.Format("2006-01-02T15:04:05Z"),
				})
			}
		}
	}

	// Merge implicit relationships into foreign_keys with Implicit:true.
	if entry.Relationships != nil && s.projectID != "" {
		rels, err := entry.Relationships.GetRelationshipsByTable(ctx, s.projectID, connName, tableName)
		if err == nil {
			for _, rel := range rels {
				var fk fkDetail
				if rel.FromTable == tableName {
					// Forward reference: this table is the child side.
					fk = fkDetail{
						Name:             rel.Label,
						Column:           rel.FromColumn,
						ReferencedTable:  rel.ToTable,
						ReferencedColumn: rel.ToColumn,
						Implicit:         true,
					}
				} else {
					// Reverse reference: this table is the parent side; swap from↔to.
					fk = fkDetail{
						Name:             rel.Label,
						Column:           rel.ToColumn,
						ReferencedTable:  rel.FromTable,
						ReferencedColumn: rel.FromColumn,
						Implicit:         true,
					}
				}
				detail.ForeignKeys = append(detail.ForeignKeys, fk)
			}
		}
	}

	return jsonResult(detail)
}

// searchResultEntry is the response shape for heydb_search, including matched columns.
// MatchSource indicates which source matched: "table_name", "column_name", "annotation", or "relationship".
type searchResultEntry struct {
	Name           string   `json:"name"`
	ColumnCount    int      `json:"column_count"`
	Comment        string   `json:"comment,omitempty"`
	MatchedColumns []string `json:"matched_columns,omitempty"`
	MatchSource    string   `json:"match_source,omitempty"`
}

func (s *Server) handleSearch(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
	entry, connName, err := s.resolveConnection(req.GetArguments())
	if err != nil {
		return mcpgo.NewToolResultError(err.Error()), nil
	}

	query, _ := req.GetArguments()["query"].(string)
	if query == "" {
		return mcpgo.NewToolResultError("query argument is required"), nil
	}

	tables, err := entry.Schema.SearchTables(ctx, query, s.projectID, connName)
	if err != nil {
		return mcpgo.NewToolResultError(fmt.Sprintf("search failed: %v", err)), nil
	}

	lowerQuery := strings.ToLower(query)

	// Build a deduplication map: table name → searchResultEntry.
	// We preserve insertion order via an ordered slice.
	resultMap := make(map[string]searchResultEntry)
	resultOrder := make([]string, 0, len(tables))

	// Build sets of tables that matched via annotation or relationship so we
	// can classify match_source accurately. These are cheap indexed queries.
	annotationMatches := make(map[string]bool)
	relationshipMatches := make(map[string]bool)

	if entry.Annotations != nil {
		allAnns, _ := entry.Annotations.GetAllAnnotations(ctx, s.projectID, connName)
		for _, a := range allAnns {
			if strings.Contains(strings.ToLower(a.Content), lowerQuery) {
				annotationMatches[a.TargetName] = true
			}
		}
	}

	if entry.Relationships != nil {
		allRels, _ := entry.Relationships.ListRelationships(ctx, s.projectID, connName)
		for _, r := range allRels {
			if strings.Contains(strings.ToLower(r.FromTable), lowerQuery) ||
				strings.Contains(strings.ToLower(r.FromColumn), lowerQuery) ||
				strings.Contains(strings.ToLower(r.ToTable), lowerQuery) ||
				strings.Contains(strings.ToLower(r.ToColumn), lowerQuery) ||
				strings.Contains(strings.ToLower(r.Label), lowerQuery) {
				relationshipMatches[r.FromTable] = true
				relationshipMatches[r.ToTable] = true
			}
		}
	}

	for _, t := range tables {
		var matched []string
		matchSource := classifyMatchSource(t.Name, lowerQuery, annotationMatches, relationshipMatches)
		for _, c := range t.Columns {
			if strings.Contains(strings.ToLower(c.Name), lowerQuery) ||
				strings.Contains(strings.ToLower(c.Comment), lowerQuery) {
				matched = append(matched, c.Name)
			}
		}
		if _, seen := resultMap[t.Name]; !seen {
			resultOrder = append(resultOrder, t.Name)
		}
		resultMap[t.Name] = searchResultEntry{
			Name:           t.Name,
			ColumnCount:    len(t.Columns),
			Comment:        t.Comment,
			MatchedColumns: matched,
			MatchSource:    matchSource,
		}
	}

	// Include tables found via annotation/relationship that SearchTables missed.
	for name := range annotationMatches {
		if _, seen := resultMap[name]; !seen {
			t, err := entry.Schema.GetTable(ctx, name)
			if err != nil {
				continue
			}
			resultOrder = append(resultOrder, name)
			resultMap[name] = searchResultEntry{
				Name:        t.Name,
				ColumnCount: len(t.Columns),
				Comment:     t.Comment,
				MatchSource: "annotation",
			}
		}
	}
	for name := range relationshipMatches {
		if _, seen := resultMap[name]; !seen {
			t, err := entry.Schema.GetTable(ctx, name)
			if err != nil {
				continue
			}
			resultOrder = append(resultOrder, name)
			resultMap[name] = searchResultEntry{
				Name:        t.Name,
				ColumnCount: len(t.Columns),
				Comment:     t.Comment,
				MatchSource: "relationship",
			}
		}
	}

	entries := make([]searchResultEntry, 0, len(resultOrder))
	for _, name := range resultOrder {
		entries = append(entries, resultMap[name])
	}

	return jsonResult(entries)
}

// classifyMatchSource determines why a table appeared in search results.
// Priority: table_name > column_name > annotation > relationship.
func classifyMatchSource(tableName, lowerQuery string, annotationMatches, relationshipMatches map[string]bool) string {
	if strings.Contains(strings.ToLower(tableName), lowerQuery) {
		return "table_name"
	}
	// If not matched by table name, check if it was an annotation or relationship match.
	if annotationMatches[tableName] {
		return "annotation"
	}
	if relationshipMatches[tableName] {
		return "relationship"
	}
	return "column_name"
}

func (s *Server) handleAnnotate(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
	args := req.GetArguments()
	entry, connName, err := s.resolveConnection(args)
	if err != nil {
		return mcpgo.NewToolResultError(err.Error()), nil
	}

	tableName, _ := args["table_name"].(string)
	annotation, _ := args["annotation"].(string)
	if tableName == "" {
		return mcpgo.NewToolResultError("table_name argument is required"), nil
	}
	if annotation == "" {
		return mcpgo.NewToolResultError("annotation argument is required"), nil
	}

	// Verify the table exists.
	if _, err := entry.Schema.GetTable(ctx, tableName); err != nil {
		names, listErr := allTableNames(ctx, entry)
		if listErr != nil {
			return mcpgo.NewToolResultError(fmt.Sprintf("table %q not found", tableName)), nil
		}
		return mcpgo.NewToolResultError(
			fmt.Sprintf("table %q not found. Available tables: %s",
				tableName, strings.Join(names, ", ")),
		), nil
	}

	if entry.Annotations == nil {
		return mcpgo.NewToolResultError("annotation store not available for this connection"), nil
	}

	ann := schema.Annotation{
		ProjectID:      s.projectID,
		ConnectionName: connName,
		TargetType:     "table",
		TargetName:     tableName,
		Content:        annotation,
		Author:         s.author,
	}
	created, err := entry.Annotations.AddAnnotation(ctx, ann)
	if err != nil {
		return mcpgo.NewToolResultError(fmt.Sprintf("failed to save annotation: %v", err)), nil
	}

	return jsonResult(annotationDetail{
		ID:        created.ID,
		Author:    created.Author,
		Content:   created.Content,
		CreatedAt: created.CreatedAt.Format("2006-01-02T15:04:05Z"),
	})
}

func (s *Server) handleAnnotateColumn(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
	args := req.GetArguments()
	entry, connName, err := s.resolveConnection(args)
	if err != nil {
		return mcpgo.NewToolResultError(err.Error()), nil
	}

	tableName, _ := args["table_name"].(string)
	columnName, _ := args["column_name"].(string)
	annotation, _ := args["annotation"].(string)
	if tableName == "" {
		return mcpgo.NewToolResultError("table_name argument is required"), nil
	}
	if columnName == "" {
		return mcpgo.NewToolResultError("column_name argument is required"), nil
	}
	if annotation == "" {
		return mcpgo.NewToolResultError("annotation argument is required"), nil
	}

	// Verify the table and column exist.
	t, err := entry.Schema.GetTable(ctx, tableName)
	if err != nil {
		names, listErr := allTableNames(ctx, entry)
		if listErr != nil {
			return mcpgo.NewToolResultError(fmt.Sprintf("table %q not found", tableName)), nil
		}
		return mcpgo.NewToolResultError(
			fmt.Sprintf("table %q not found. Available tables: %s",
				tableName, strings.Join(names, ", ")),
		), nil
	}

	found := false
	for _, c := range t.Columns {
		if c.Name == columnName {
			found = true
			break
		}
	}
	if !found {
		colNames := make([]string, 0, len(t.Columns))
		for _, c := range t.Columns {
			colNames = append(colNames, c.Name)
		}
		return mcpgo.NewToolResultError(
			fmt.Sprintf("column %q not found in table %q. Available columns: %s",
				columnName, tableName, strings.Join(colNames, ", ")),
		), nil
	}

	if entry.Annotations == nil {
		return mcpgo.NewToolResultError("annotation store not available for this connection"), nil
	}

	ann := schema.Annotation{
		ProjectID:      s.projectID,
		ConnectionName: connName,
		TargetType:     "column",
		TargetName:     tableName + "." + columnName,
		Content:        annotation,
		Author:         s.author,
	}
	created, err := entry.Annotations.AddAnnotation(ctx, ann)
	if err != nil {
		return mcpgo.NewToolResultError(fmt.Sprintf("failed to save column annotation: %v", err)), nil
	}

	return jsonResult(annotationDetail{
		ID:        created.ID,
		Author:    created.Author,
		Content:   created.Content,
		CreatedAt: created.CreatedAt.Format("2006-01-02T15:04:05Z"),
	})
}

func (s *Server) handleAnnotateDB(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
	args := req.GetArguments()
	entry, connName, err := s.resolveConnection(args)
	if err != nil {
		return mcpgo.NewToolResultError(err.Error()), nil
	}

	annotation, _ := args["annotation"].(string)
	if annotation == "" {
		return mcpgo.NewToolResultError("annotation argument is required"), nil
	}

	if entry.Annotations == nil {
		return mcpgo.NewToolResultError("annotation store not available for this connection"), nil
	}

	ann := schema.Annotation{
		ProjectID:      s.projectID,
		ConnectionName: connName,
		TargetType:     "db",
		TargetName:     "",
		Content:        annotation,
		Author:         s.author,
	}
	created, err := entry.Annotations.AddAnnotation(ctx, ann)
	if err != nil {
		return mcpgo.NewToolResultError(fmt.Sprintf("failed to save database annotation: %v", err)), nil
	}

	return jsonResult(annotationDetail{
		ID:        created.ID,
		Author:    created.Author,
		Content:   created.Content,
		CreatedAt: created.CreatedAt.Format("2006-01-02T15:04:05Z"),
	})
}

func (s *Server) handleEditAnnotation(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
	args := req.GetArguments()
	// Resolve connection to get the annotation store (prefer active conn if omitted).
	entry, _, err := s.resolveConnection(args)
	if err != nil {
		return mcpgo.NewToolResultError(err.Error()), nil
	}

	id, _ := args["id"].(string)
	content, _ := args["content"].(string)
	if id == "" {
		return mcpgo.NewToolResultError("id argument is required"), nil
	}
	if content == "" {
		return mcpgo.NewToolResultError("content argument is required"), nil
	}

	if entry.Annotations == nil {
		return mcpgo.NewToolResultError("annotation store not available for this connection"), nil
	}

	updated, err := entry.Annotations.EditAnnotation(ctx, id, content)
	if err != nil {
		return mcpgo.NewToolResultError(fmt.Sprintf("failed to edit annotation: %v", err)), nil
	}

	return jsonResult(annotationDetail{
		ID:        updated.ID,
		Author:    updated.Author,
		Content:   updated.Content,
		CreatedAt: updated.CreatedAt.Format("2006-01-02T15:04:05Z"),
	})
}

func (s *Server) handleDeleteAnnotation(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
	args := req.GetArguments()
	entry, _, err := s.resolveConnection(args)
	if err != nil {
		return mcpgo.NewToolResultError(err.Error()), nil
	}

	id, _ := args["id"].(string)
	if id == "" {
		return mcpgo.NewToolResultError("id argument is required"), nil
	}

	if entry.Annotations == nil {
		return mcpgo.NewToolResultError("annotation store not available for this connection"), nil
	}

	if err := entry.Annotations.DeleteAnnotation(ctx, id); err != nil {
		return mcpgo.NewToolResultError(fmt.Sprintf("failed to delete annotation: %v", err)), nil
	}

	return mcpgo.NewToolResultText(fmt.Sprintf("Annotation %q deleted", id)), nil
}

// ── relationship handlers ─────────────────────────────────────────────────────

// relationshipDetail is the wire shape for an implicit relationship in tool responses.
type relationshipDetail struct {
	ID             string `json:"id"`
	FromTable      string `json:"from_table"`
	FromColumn     string `json:"from_column"`
	ToTable        string `json:"to_table"`
	ToColumn       string `json:"to_column"`
	Label          string `json:"label,omitempty"`
	Author         string `json:"author,omitempty"`
	CreatedAt      string `json:"created_at,omitempty"`
}

func (s *Server) handleAddRelationship(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
	args := req.GetArguments()
	entry, connName, err := s.resolveConnection(args)
	if err != nil {
		return mcpgo.NewToolResultError(err.Error()), nil
	}

	fromTable, _ := args["from_table"].(string)
	fromColumn, _ := args["from_column"].(string)
	toTable, _ := args["to_table"].(string)
	toColumn, _ := args["to_column"].(string)
	label, _ := args["label"].(string)

	if fromTable == "" {
		return mcpgo.NewToolResultError("from_table argument is required"), nil
	}
	if fromColumn == "" {
		return mcpgo.NewToolResultError("from_column argument is required"), nil
	}
	if toTable == "" {
		return mcpgo.NewToolResultError("to_table argument is required"), nil
	}
	if toColumn == "" {
		return mcpgo.NewToolResultError("to_column argument is required"), nil
	}

	if entry.Relationships == nil {
		return mcpgo.NewToolResultError("relationship store not available for this connection"), nil
	}

	// Validate from_table and from_column exist.
	fromT, err := entry.Schema.GetTable(ctx, fromTable)
	if err != nil {
		names, _ := allTableNames(ctx, entry)
		return mcpgo.NewToolResultError(
			fmt.Sprintf("from_table %q not found. Available tables: %s",
				fromTable, strings.Join(names, ", ")),
		), nil
	}
	if !columnExists(fromT, fromColumn) {
		return mcpgo.NewToolResultError(
			fmt.Sprintf("from_column %q not found in table %q", fromColumn, fromTable),
		), nil
	}

	// Validate to_table and to_column exist.
	toT, err := entry.Schema.GetTable(ctx, toTable)
	if err != nil {
		names, _ := allTableNames(ctx, entry)
		return mcpgo.NewToolResultError(
			fmt.Sprintf("to_table %q not found. Available tables: %s",
				toTable, strings.Join(names, ", ")),
		), nil
	}
	if !columnExists(toT, toColumn) {
		return mcpgo.NewToolResultError(
			fmt.Sprintf("to_column %q not found in table %q", toColumn, toTable),
		), nil
	}

	rel := schema.ImplicitRelationship{
		ProjectID:      s.projectID,
		ConnectionName: connName,
		FromTable:      fromTable,
		FromColumn:     fromColumn,
		ToTable:        toTable,
		ToColumn:       toColumn,
		Label:          label,
		Author:         s.author,
	}
	created, err := entry.Relationships.AddRelationship(ctx, rel)
	if err != nil {
		return mcpgo.NewToolResultError(fmt.Sprintf("failed to save relationship: %v", err)), nil
	}

	return jsonResult(relationshipDetail{
		ID:         created.ID,
		FromTable:  created.FromTable,
		FromColumn: created.FromColumn,
		ToTable:    created.ToTable,
		ToColumn:   created.ToColumn,
		Label:      created.Label,
		Author:     created.Author,
		CreatedAt:  created.CreatedAt.Format("2006-01-02T15:04:05Z"),
	})
}

func (s *Server) handleDeleteRelationship(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
	args := req.GetArguments()
	entry, _, err := s.resolveConnection(args)
	if err != nil {
		return mcpgo.NewToolResultError(err.Error()), nil
	}

	id, _ := args["id"].(string)
	if id == "" {
		return mcpgo.NewToolResultError("id argument is required"), nil
	}

	if entry.Relationships == nil {
		return mcpgo.NewToolResultError("relationship store not available for this connection"), nil
	}

	if err := entry.Relationships.DeleteRelationship(ctx, id); err != nil {
		return mcpgo.NewToolResultError(fmt.Sprintf("failed to delete relationship: %v", err)), nil
	}

	return jsonResult(map[string]any{"deleted": true, "id": id})
}

func (s *Server) handleListRelationships(ctx context.Context, req mcpgo.CallToolRequest) (*mcpgo.CallToolResult, error) {
	args := req.GetArguments()
	entry, connName, err := s.resolveConnection(args)
	if err != nil {
		return mcpgo.NewToolResultError(err.Error()), nil
	}

	if entry.Relationships == nil {
		return jsonResult([]relationshipDetail{})
	}

	rels, err := entry.Relationships.ListRelationships(ctx, s.projectID, connName)
	if err != nil {
		return mcpgo.NewToolResultError(fmt.Sprintf("failed to list relationships: %v", err)), nil
	}

	result := make([]relationshipDetail, 0, len(rels))
	for _, r := range rels {
		result = append(result, relationshipDetail{
			ID:         r.ID,
			FromTable:  r.FromTable,
			FromColumn: r.FromColumn,
			ToTable:    r.ToTable,
			ToColumn:   r.ToColumn,
			Label:      r.Label,
			Author:     r.Author,
			CreatedAt:  r.CreatedAt.Format("2006-01-02T15:04:05Z"),
		})
	}

	return jsonResult(result)
}

// ── helpers ──────────────────────────────────────────────────────────────────

// columnExists returns true if tableName has a column named columnName.
func columnExists(t schema.Table, columnName string) bool {
	for _, c := range t.Columns {
		if c.Name == columnName {
			return true
		}
	}
	return false
}

// allTableNames returns a list of all table names from a ConnEntry's schema store.
func allTableNames(ctx context.Context, entry *ConnEntry) ([]string, error) {
	sc, err := entry.Schema.LoadSchema(ctx)
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
		Annotations: []annotationDetail{}, // always non-null; populated by handleGetTable
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
