package schema

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sort"
	"time"
)

// Schema holds the full captured state of a database schema.
type Schema struct {
	Database string    `json:"database"`
	Tables   []Table   `json:"tables"`
	Hash     string    `json:"hash"`
	SyncedAt time.Time `json:"synced_at"`
	Engine   string    `json:"engine"`  // e.g. "mysql"
	Version  string    `json:"version"` // heydb format version, e.g. "1.0"
}

// Table represents a single database table.
type Table struct {
	Name        string       `json:"name"`
	Engine      string       `json:"engine"` // e.g. "InnoDB"
	Comment     string       `json:"comment"`
	Columns     []Column     `json:"columns"`
	PrimaryKey  []string     `json:"primary_key"` // ordered column names
	Indexes     []Index      `json:"indexes"`
	ForeignKeys []ForeignKey `json:"foreign_keys"`
}

// Column represents a single column definition.
type Column struct {
	Name       string  `json:"name"`
	OrdinalPos int     `json:"ordinal_position"`
	Type       string  `json:"type"`    // full type, e.g. "bigint unsigned"
	Nullable   bool    `json:"nullable"`
	Default    *string `json:"default"` // nil means no default
	Key        string  `json:"key"`     // PRI, UNI, MUL, or ""
	Extra      string  `json:"extra"`   // auto_increment, on update CURRENT_TIMESTAMP, etc.
	Comment    string  `json:"comment"`
}

// Index represents a table index (excluding the primary key, which is in Table.PrimaryKey).
type Index struct {
	Name    string   `json:"name"`
	Columns []string `json:"columns"`
	Unique  bool     `json:"unique"`
	Type    string   `json:"type"` // BTREE, FULLTEXT, HASH, etc.
}

// ForeignKey represents a single foreign key constraint, either native (enforced
// by the database engine) or implicit (user-defined, stored in heydb).
type ForeignKey struct {
	Name             string `json:"name"`
	Column           string `json:"column"`
	ReferencedTable  string `json:"referenced_table"`
	ReferencedColumn string `json:"referenced_column"`
	Implicit         bool   `json:"implicit,omitempty"` // true for user-defined implicit relationships
}

// canonicalTable is the minimal representation used for hash computation.
// It must stay stable across heydb versions to avoid spurious drift.
type canonicalTable struct {
	Name    string            `json:"name"`
	Columns []canonicalColumn `json:"columns"`
}

type canonicalColumn struct {
	Name     string  `json:"name"`
	Type     string  `json:"type"`
	Nullable bool    `json:"nullable"`
	Default  *string `json:"default"`
	Extra    string  `json:"extra"`
}

// ComputeHash returns a deterministic SHA-256 hex string over the canonical
// JSON representation of tables, sorted by table name. Columns within each
// table are sorted by OrdinalPos.
//
// This is the authoritative hash algorithm. Any change to the canonical form
// MUST be treated as a breaking change and bumped in Schema.Version.
func ComputeHash(tables []Table) string {
	sorted := make([]Table, len(tables))
	copy(sorted, tables)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i].Name < sorted[j].Name
	})

	canonical := make([]canonicalTable, 0, len(sorted))
	for _, t := range sorted {
		cols := make([]Column, len(t.Columns))
		copy(cols, t.Columns)
		sort.Slice(cols, func(i, j int) bool {
			return cols[i].OrdinalPos < cols[j].OrdinalPos
		})

		cc := make([]canonicalColumn, 0, len(cols))
		for _, c := range cols {
			cc = append(cc, canonicalColumn{
				Name:     c.Name,
				Type:     c.Type,
				Nullable: c.Nullable,
				Default:  c.Default,
				Extra:    c.Extra,
			})
		}
		canonical = append(canonical, canonicalTable{Name: t.Name, Columns: cc})
	}

	data, err := json.Marshal(canonical)
	if err != nil {
		// json.Marshal only fails on non-serialisable types; our struct has none.
		panic(fmt.Sprintf("schema.ComputeHash: unexpected marshal error: %v", err))
	}

	sum := sha256.Sum256(data)
	return fmt.Sprintf("%x", sum)
}
