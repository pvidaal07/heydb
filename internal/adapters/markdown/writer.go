// Package markdown provides a writer and parser for heydb.md — the
// human-readable, machine-parseable schema documentation file.
//
// Anchor contract (HTML comments used as parser delimiters):
//
//	<!-- heydb:meta -->                         file-level metadata block
//	<!-- heydb:toc -->..<!-- /heydb:toc -->     table of contents
//	<!-- heydb:table name="X" -->               start of a table section
//	<!-- /heydb:table -->                       end of a table section
//	<!-- heydb:annotations -->                  start of preserved annotation block
//	<!-- /heydb:annotations -->                 end of preserved annotation block
package markdown

import (
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// formatAnnotationLine renders a single v2 annotation as a blockquote line.
//
//	> **Annotation** by author (YYYY-MM-DD): content
func formatAnnotationLine(ann schema.Annotation) string {
	date := ann.UpdatedAt.UTC().Format("2006-01-02")
	return fmt.Sprintf("> **Annotation** by %s (%s): %s\n",
		ann.Author, date, ann.Content)
}

const heydbVersion = "1.0"

// WriteOptions carries optional state from a previous heydb.md parse, used to
// preserve human-authored annotation blocks during re-sync.
type WriteOptions struct {
	// Annotations maps table name → preserved annotation block content
	// (everything between <!-- heydb:annotations --> and <!-- /heydb:annotations -->).
	// Used by legacy (v1) round-trip; ignored when V2Annotations is set.
	Annotations map[string]string

	// ColumnAnnotations maps table name → (column name → annotation content).
	ColumnAnnotations map[string]map[string]string

	// DBAnnotation is the database-level annotation content (v1 legacy).
	DBAnnotation string

	// V2Annotations is the v2 list of accumulative annotations with author +
	// timestamp. When non-nil, these are rendered instead of the legacy fields.
	V2Annotations []schema.Annotation
}

// Write generates the full heydb.md content for s and writes it to w.
// opts may be nil; if not nil, annotation blocks from the previous file are
// re-injected verbatim into their corresponding table sections.
func Write(w io.Writer, s schema.Schema, opts *WriteOptions) error {
	if opts == nil {
		opts = &WriteOptions{}
	}

	b := &strings.Builder{}

	// ── File header ──────────────────────────────────────────────────────────
	b.WriteString("# heydb schema documentation\n\n")
	b.WriteString(fmt.Sprintf("Database: **%s**\n\n", s.Database))

	// ── Database annotation ──────────────────────────────────────────────────
	if opts.V2Annotations != nil {
		// v2 path: render db-level annotations from the slice.
		for _, ann := range opts.V2Annotations {
			if ann.TargetType == "db" {
				b.WriteString(formatAnnotationLine(ann))
			}
		}
		if hasDBAnnotations(opts.V2Annotations) {
			b.WriteString("\n")
		}
	} else if opts.DBAnnotation != "" {
		// v1 legacy path.
		b.WriteString("<!-- heydb:db-annotation -->\n")
		b.WriteString(opts.DBAnnotation)
		if !strings.HasSuffix(opts.DBAnnotation, "\n") {
			b.WriteString("\n")
		}
		b.WriteString("<!-- /heydb:db-annotation -->\n\n")
	}

	// ── Meta block ───────────────────────────────────────────────────────────
	b.WriteString("<!-- heydb:meta\n")
	b.WriteString(fmt.Sprintf("schema_hash: %s\n", s.Hash))
	b.WriteString(fmt.Sprintf("synced_at: %s\n", s.SyncedAt.UTC().Format(time.RFC3339)))
	b.WriteString(fmt.Sprintf("engine: %s\n", s.Engine))
	b.WriteString(fmt.Sprintf("heydb_version: %s\n", heydbVersion))
	b.WriteString("-->\n\n")

	// ── Table of contents ────────────────────────────────────────────────────
	b.WriteString("<!-- heydb:toc -->\n")
	b.WriteString("## Tables\n\n")
	for _, t := range s.Tables {
		anchor := tableAnchor(t.Name)
		b.WriteString(fmt.Sprintf("- [%s](#%s)\n", t.Name, anchor))
	}
	b.WriteString("\n<!-- /heydb:toc -->\n\n")

	// ── Per-table sections ───────────────────────────────────────────────────
	for idx, t := range s.Tables {
		if opts.V2Annotations != nil {
			writeTableV2(b, t, opts.V2Annotations)
		} else {
			writeTable(b, t, opts.Annotations[t.Name], opts.ColumnAnnotations[t.Name])
		}
		if idx < len(s.Tables)-1 {
			b.WriteString("\n---\n\n")
		}
	}

	_, err := io.WriteString(w, b.String())
	return err
}

// writeTable emits the full markdown block for a single table.
func writeTable(b *strings.Builder, t schema.Table, annotation string, colAnnotations map[string]string) {
	b.WriteString(fmt.Sprintf("<!-- heydb:table name=%q -->\n", t.Name))
	b.WriteString(fmt.Sprintf("## %s\n\n", t.Name))

	if t.Comment != "" {
		b.WriteString(fmt.Sprintf("> %s\n\n", t.Comment))
	}
	if t.Engine != "" {
		b.WriteString(fmt.Sprintf("Engine: `%s`\n\n", t.Engine))
	}

	// Columns table
	b.WriteString("### Columns\n\n")
	b.WriteString("| Column | Type | Nullable | Default | Key | Extra | Comment |\n")
	b.WriteString("|--------|------|----------|---------|-----|-------|----------|\n")
	for _, c := range t.Columns {
		def := ""
		if c.Default != nil {
			def = *c.Default
		}
		nullable := "NO"
		if c.Nullable {
			nullable = "YES"
		}
		b.WriteString(fmt.Sprintf("| %s | `%s` | %s | %s | %s | %s | %s |\n",
			mdEscape(c.Name),
			mdEscape(c.Type),
			nullable,
			mdEscape(def),
			mdEscape(c.Key),
			mdEscape(c.Extra),
			mdEscape(c.Comment),
		))
	}
	b.WriteString("\n")

	// Column annotations
	if len(colAnnotations) > 0 {
		for _, c := range t.Columns {
			if ann, ok := colAnnotations[c.Name]; ok && ann != "" {
				b.WriteString(fmt.Sprintf("<!-- heydb:col-annotation name=%q -->\n", c.Name))
				b.WriteString(ann)
				if !strings.HasSuffix(ann, "\n") {
					b.WriteString("\n")
				}
				b.WriteString("<!-- /heydb:col-annotation -->\n\n")
			}
		}
	}

	// Primary key
	if len(t.PrimaryKey) > 0 {
		b.WriteString("**Primary Key:** ")
		pks := make([]string, len(t.PrimaryKey))
		for i, pk := range t.PrimaryKey {
			pks[i] = fmt.Sprintf("`%s`", pk)
		}
		b.WriteString(strings.Join(pks, ", "))
		b.WriteString("\n\n")
	}

	// Indexes
	if len(t.Indexes) > 0 {
		b.WriteString("### Indexes\n\n")
		b.WriteString("| Name | Columns | Unique | Type |\n")
		b.WriteString("|------|---------|--------|------|\n")
		for _, idx := range t.Indexes {
			unique := "NO"
			if idx.Unique {
				unique = "YES"
			}
			cols := make([]string, len(idx.Columns))
			for i, c := range idx.Columns {
				cols[i] = fmt.Sprintf("`%s`", c)
			}
			b.WriteString(fmt.Sprintf("| %s | %s | %s | %s |\n",
				mdEscape(idx.Name),
				strings.Join(cols, ", "),
				unique,
				idx.Type,
			))
		}
		b.WriteString("\n")
	}

	// Foreign keys
	if len(t.ForeignKeys) > 0 {
		b.WriteString("### Foreign Keys\n\n")
		b.WriteString("| Name | Column | References |\n")
		b.WriteString("|------|--------|------------|\n")
		for _, fk := range t.ForeignKeys {
			b.WriteString(fmt.Sprintf("| %s | `%s` | `%s`.`%s` |\n",
				mdEscape(fk.Name),
				mdEscape(fk.Column),
				mdEscape(fk.ReferencedTable),
				mdEscape(fk.ReferencedColumn),
			))
		}
		b.WriteString("\n")
	}

	// Preserved annotation block
	if annotation != "" {
		b.WriteString("<!-- heydb:annotations -->\n")
		b.WriteString(annotation)
		if !strings.HasSuffix(annotation, "\n") {
			b.WriteString("\n")
		}
		b.WriteString("<!-- /heydb:annotations -->\n\n")
	}

	b.WriteString("<!-- /heydb:table -->\n")
}

// hasDBAnnotations returns true if any annotation in the list targets the database level.
func hasDBAnnotations(annotations []schema.Annotation) bool {
	for _, ann := range annotations {
		if ann.TargetType == "db" {
			return true
		}
	}
	return false
}

// writeTableV2 emits a table block with v2 annotations (author + timestamp).
func writeTableV2(b *strings.Builder, t schema.Table, annotations []schema.Annotation) {
	b.WriteString(fmt.Sprintf("<!-- heydb:table name=%q -->\n", t.Name))
	b.WriteString(fmt.Sprintf("## %s\n\n", t.Name))

	if t.Comment != "" {
		b.WriteString(fmt.Sprintf("> %s\n\n", t.Comment))
	}
	if t.Engine != "" {
		b.WriteString(fmt.Sprintf("Engine: `%s`\n\n", t.Engine))
	}

	// Columns table
	b.WriteString("### Columns\n\n")
	b.WriteString("| Column | Type | Nullable | Default | Key | Extra | Comment |\n")
	b.WriteString("|--------|------|----------|---------|-----|-------|----------|\n")
	for _, c := range t.Columns {
		def := ""
		if c.Default != nil {
			def = *c.Default
		}
		nullable := "NO"
		if c.Nullable {
			nullable = "YES"
		}
		b.WriteString(fmt.Sprintf("| %s | `%s` | %s | %s | %s | %s | %s |\n",
			mdEscape(c.Name),
			mdEscape(c.Type),
			nullable,
			mdEscape(def),
			mdEscape(c.Key),
			mdEscape(c.Extra),
			mdEscape(c.Comment),
		))

		// Per-column v2 annotations
		colKey := t.Name + "." + c.Name
		for _, ann := range annotations {
			if ann.TargetType == "column" && ann.TargetName == colKey {
				b.WriteString(formatAnnotationLine(ann))
			}
		}
	}
	b.WriteString("\n")

	// Primary key
	if len(t.PrimaryKey) > 0 {
		b.WriteString("**Primary Key:** ")
		pks := make([]string, len(t.PrimaryKey))
		for i, pk := range t.PrimaryKey {
			pks[i] = fmt.Sprintf("`%s`", pk)
		}
		b.WriteString(strings.Join(pks, ", "))
		b.WriteString("\n\n")
	}

	// Indexes
	if len(t.Indexes) > 0 {
		b.WriteString("### Indexes\n\n")
		b.WriteString("| Name | Columns | Unique | Type |\n")
		b.WriteString("|------|---------|--------|------|\n")
		for _, idx := range t.Indexes {
			unique := "NO"
			if idx.Unique {
				unique = "YES"
			}
			cols := make([]string, len(idx.Columns))
			for i, c := range idx.Columns {
				cols[i] = fmt.Sprintf("`%s`", c)
			}
			b.WriteString(fmt.Sprintf("| %s | %s | %s | %s |\n",
				mdEscape(idx.Name),
				strings.Join(cols, ", "),
				unique,
				idx.Type,
			))
		}
		b.WriteString("\n")
	}

	// Foreign keys
	if len(t.ForeignKeys) > 0 {
		b.WriteString("### Foreign Keys\n\n")
		b.WriteString("| Name | Column | References |\n")
		b.WriteString("|------|--------|------------|\n")
		for _, fk := range t.ForeignKeys {
			b.WriteString(fmt.Sprintf("| %s | `%s` | `%s`.`%s` |\n",
				mdEscape(fk.Name),
				mdEscape(fk.Column),
				mdEscape(fk.ReferencedTable),
				mdEscape(fk.ReferencedColumn),
			))
		}
		b.WriteString("\n")
	}

	// Table-level v2 annotations
	for _, ann := range annotations {
		if ann.TargetType == "table" && ann.TargetName == t.Name {
			b.WriteString(formatAnnotationLine(ann))
		}
	}

	b.WriteString("<!-- /heydb:table -->\n")
}

// tableAnchor converts a table name to the lowercase hyphenated anchor that
// GitHub Markdown generates from headings. Only letters, digits, and hyphens
// are kept; spaces become hyphens.
func tableAnchor(name string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(name) {
		if r == ' ' || r == '_' {
			b.WriteRune('-')
		} else if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// mdEscape escapes pipe characters that would break Markdown table syntax.
func mdEscape(s string) string {
	return strings.ReplaceAll(s, "|", `\|`)
}
