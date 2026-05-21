// Package introspection provides use-cases that coordinate between domain
// ports. It has no knowledge of which concrete adapters are used.
package introspection

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/pvidaal07/heydb/internal/domain/ports"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// SyncResult is returned after a successful sync run.
type SyncResult struct {
	// TablesCount is the number of tables introspected.
	TablesCount int
	// Hash is the computed schema_hash written to both outputs.
	Hash string
	// Database is the name of the source database.
	Database string
}

// SchemaWriter writes a schema to an output (e.g. Markdown file).
type SchemaWriter interface {
	WriteSchema(s schema.Schema) error
}

// Syncer runs the sync pipeline: MySQL → domain objects → SchemaWriter + SQLite.
type Syncer struct {
	introspector ports.DBIntrospector
	store        schemaStoreWriter
	writer       SchemaWriter
	// verbose enables progress messages to stderr
	verbose bool
}

// schemaStoreWriter is the minimal subset of ports.SchemaStore used by Sync.
type schemaStoreWriter interface {
	SaveSchema(ctx context.Context, s schema.Schema) error
}

// NewSyncer constructs a Syncer.
// writer receives the schema after introspection (e.g. a Markdown writer).
func NewSyncer(
	introspector ports.DBIntrospector,
	store schemaStoreWriter,
	writer SchemaWriter,
	verbose bool,
) *Syncer {
	return &Syncer{
		introspector: introspector,
		store:        store,
		writer:       writer,
		verbose:      verbose,
	}
}

// Run executes the full sync pipeline and returns a SyncResult.
// The caller is responsible for connecting / closing the introspector.
func (s *Syncer) Run(ctx context.Context, databaseName string) (SyncResult, error) {
	// 1. List tables.
	fmt.Fprint(os.Stderr, "Listing tables... ")
	tableNames, err := s.introspector.ListTables(ctx)
	if err != nil {
		return SyncResult{}, fmt.Errorf("sync: list tables: %w", err)
	}
	fmt.Fprintf(os.Stderr, "found %d\n", len(tableNames))

	// 2. Fetch full detail for each table.
	tables := make([]schema.Table, 0, len(tableNames))
	for i, name := range tableNames {
		if s.verbose {
			fmt.Fprintf(os.Stderr, "  [%d/%d] %s\n", i+1, len(tableNames), name)
		}
		t, err := s.introspector.GetTable(ctx, name)
		if err != nil {
			return SyncResult{}, fmt.Errorf("sync: get table %q: %w", name, err)
		}
		tables = append(tables, t)
	}

	// 3. Compute hash.
	hash := schema.ComputeHash(tables)

	// 4. Build domain schema.
	sc := schema.Schema{
		Database: databaseName,
		Tables:   tables,
		Hash:     hash,
		SyncedAt: time.Now().UTC(),
		Engine:   "mysql",
		Version:  "1.0",
	}

	// 5. Save to SQLite store.
	if err := s.store.SaveSchema(ctx, sc); err != nil {
		return SyncResult{}, fmt.Errorf("sync: save schema to sqlite: %w", err)
	}

	// 6. Write schema to output (e.g. heydb.md) — only if a writer is provided.
	if s.writer != nil {
		if err := s.writer.WriteSchema(sc); err != nil {
			return SyncResult{}, fmt.Errorf("sync: write schema: %w", err)
		}
	}

	return SyncResult{
		TablesCount: len(tables),
		Hash:        hash,
		Database:    databaseName,
	}, nil
}
