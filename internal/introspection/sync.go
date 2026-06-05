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

// DBLite is the minimal interface for per-database introspection inside RunMultiDB.
// It doesn't include Connect/Close because the parent manages the connection.
type DBLite interface {
	ListTables(ctx context.Context) ([]string, error)
	GetTable(ctx context.Context, name string) (schema.Table, error)
}

// MultiDBFactory lists databases and creates per-database introspectors.
type MultiDBFactory interface {
	ListDatabases(ctx context.Context) ([]string, error)
	ForDatabase(database string) DBLite
}

// RunMultiDB syncs every database returned by factory.ListDatabases.
// For each database it creates a scoped introspector, fetches all tables,
// and saves one schema per database to the store.
func RunMultiDB(
	ctx context.Context,
	factory MultiDBFactory,
	store schemaStoreWriter,
	verbose bool,
) ([]SyncResult, error) {
	databases, err := factory.ListDatabases(ctx)
	if err != nil {
		return nil, fmt.Errorf("multi-db sync: list databases: %w", err)
	}

	results := make([]SyncResult, 0, len(databases))
	for _, dbName := range databases {
		if verbose {
			fmt.Fprintf(os.Stderr, "[multi-db] syncing %q\n", dbName)
		}

		intro := factory.ForDatabase(dbName)

		tableNames, err := intro.ListTables(ctx)
		if err != nil {
			return nil, fmt.Errorf("multi-db sync: list tables for %q: %w", dbName, err)
		}

		tables := make([]schema.Table, 0, len(tableNames))
		for _, name := range tableNames {
			t, err := intro.GetTable(ctx, name)
			if err != nil {
				return nil, fmt.Errorf("multi-db sync: get table %q in %q: %w", name, dbName, err)
			}
			tables = append(tables, t)
		}

		hash := schema.ComputeHash(tables)

		sc := schema.Schema{
			Database: dbName,
			Tables:   tables,
			Hash:     hash,
			SyncedAt: time.Now().UTC(),
			Engine:   "mysql",
			Version:  "1.0",
		}

		if err := store.SaveSchema(ctx, sc); err != nil {
			return nil, fmt.Errorf("multi-db sync: save %q: %w", dbName, err)
		}

		results = append(results, SyncResult{
			TablesCount: len(tables),
			Hash:        hash,
			Database:    dbName,
		})
	}

	return results, nil
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
