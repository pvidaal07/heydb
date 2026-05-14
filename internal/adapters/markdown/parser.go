package markdown

import (
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// ParsedFile is the result of parsing an existing heydb.md.
type ParsedFile struct {
	// Meta fields
	SchemaHash   string
	SyncedAt     time.Time
	Engine       string
	HeydbVersion string

	// Tables extracted from all <!-- heydb:table --> blocks
	Tables []schema.Table

	// Annotations maps table name → raw content between annotation anchors.
	// These are preserved on re-sync.
	Annotations map[string]string
}

// Regexp patterns — all multiline so we can extract block bodies with [^]* tricks.
var (
	reMetaBlock  = regexp.MustCompile(`(?s)<!--\s*heydb:meta\s*\n(.*?)\s*-->`)
	reTableBlock = regexp.MustCompile(`(?s)<!--\s*heydb:table\s+name="([^"]+)"\s*-->(.*?)<!--\s*/heydb:table\s*-->`)
	reAnnotation = regexp.MustCompile(`(?s)<!--\s*heydb:annotations\s*-->\n?(.*?)<!--\s*/heydb:annotations\s*-->`)
)

// Parse reads the content of a heydb.md file and returns the extracted data.
func Parse(content string) (*ParsedFile, error) {
	pf := &ParsedFile{
		Annotations: make(map[string]string),
	}

	// ── 1. Meta block ─────────────────────────────────────────────────────────
	if m := reMetaBlock.FindStringSubmatch(content); m != nil {
		parseMeta(m[1], pf)
	}

	// ── 2. Table blocks ───────────────────────────────────────────────────────
	tableMatches := reTableBlock.FindAllStringSubmatch(content, -1)
	for _, tm := range tableMatches {
		tableName := tm[1]
		tableBody := tm[2]

		t, err := parseTableBody(tableName, tableBody)
		if err != nil {
			return nil, fmt.Errorf("markdown: parse table %q: %w", tableName, err)
		}
		pf.Tables = append(pf.Tables, t)

		// Extract annotation block if present inside this table section
		if am := reAnnotation.FindStringSubmatch(tableBody); am != nil {
			pf.Annotations[tableName] = am[1]
		}
	}

	return pf, nil
}

// parseMeta reads key: value lines from the meta block body.
func parseMeta(body string, pf *ParsedFile) {
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		idx := strings.Index(line, ":")
		if idx < 0 {
			continue
		}
		key := strings.TrimSpace(line[:idx])
		val := strings.TrimSpace(line[idx+1:])
		switch key {
		case "schema_hash":
			pf.SchemaHash = val
		case "synced_at":
			t, err := time.Parse(time.RFC3339, val)
			if err == nil {
				pf.SyncedAt = t
			}
		case "engine":
			pf.Engine = val
		case "heydb_version":
			pf.HeydbVersion = val
		}
	}
}

// Regexps for parsing the body of a single table block.
var (
	// Matches a Markdown table row: | cell | cell | ...
	reTableRow = regexp.MustCompile(`^\|(.+)\|$`)

	rePrimaryKey = regexp.MustCompile(`\*\*Primary Key:\*\*\s*(.+)`)

	reIndexSection  = regexp.MustCompile(`(?s)### Indexes\s*\n\n\|[^\n]+\|\n\|[^\n]+\|\n((?:\|[^\n]+\|\n?)*)`)
	reFKSection     = regexp.MustCompile(`(?s)### Foreign Keys\s*\n\n\|[^\n]+\|\n\|[^\n]+\|\n((?:\|[^\n]+\|\n?)*)`)
	reColumnsSection = regexp.MustCompile(`(?s)### Columns\s*\n\n\|[^\n]+\|\n\|[^\n]+\|\n((?:\|[^\n]+\|\n?)*)`)
)

// parseTableBody reconstructs a schema.Table from the markdown between
// <!-- heydb:table --> and <!-- /heydb:table --> anchors.
func parseTableBody(name, body string) (schema.Table, error) {
	t := schema.Table{Name: name}

	// ── Columns ───────────────────────────────────────────────────────────────
	if m := reColumnsSection.FindStringSubmatch(body); m != nil {
		rows := parseMarkdownRows(m[1])
		for ord, cells := range rows {
			if len(cells) < 7 {
				continue
			}
			col := schema.Column{
				Name:       mdUnescape(cells[0]),
				Type:       strings.Trim(mdUnescape(cells[1]), "`"),
				OrdinalPos: ord + 1,
				Key:        mdUnescape(cells[4]),
				Extra:      mdUnescape(cells[5]),
				Comment:    mdUnescape(cells[6]),
			}
			col.Nullable = strings.EqualFold(strings.TrimSpace(cells[2]), "YES")
			if def := strings.TrimSpace(mdUnescape(cells[3])); def != "" {
				v := def
				col.Default = &v
			}
			t.Columns = append(t.Columns, col)
		}
	}

	// ── Primary key ───────────────────────────────────────────────────────────
	if m := rePrimaryKey.FindStringSubmatch(body); m != nil {
		// Each column is wrapped in backticks: `col1`, `col2`
		parts := strings.Split(m[1], ",")
		for _, p := range parts {
			col := strings.Trim(strings.TrimSpace(p), "`")
			if col != "" {
				t.PrimaryKey = append(t.PrimaryKey, col)
			}
		}
	}

	// ── Indexes ───────────────────────────────────────────────────────────────
	if m := reIndexSection.FindStringSubmatch(body); m != nil {
		rows := parseMarkdownRows(m[1])
		for _, cells := range rows {
			if len(cells) < 4 {
				continue
			}
			idx := schema.Index{
				Name:   mdUnescape(cells[0]),
				Unique: strings.EqualFold(strings.TrimSpace(cells[2]), "YES"),
				Type:   strings.TrimSpace(cells[3]),
			}
			// Columns are separated by ", " and wrapped in backticks
			for _, raw := range strings.Split(cells[1], ",") {
				col := strings.Trim(strings.TrimSpace(raw), "`")
				if col != "" {
					idx.Columns = append(idx.Columns, col)
				}
			}
			t.Indexes = append(t.Indexes, idx)
		}
	}

	// ── Foreign keys ──────────────────────────────────────────────────────────
	if m := reFKSection.FindStringSubmatch(body); m != nil {
		rows := parseMarkdownRows(m[1])
		for _, cells := range rows {
			if len(cells) < 3 {
				continue
			}
			// References column format: `table`.`column`
			refPart := strings.TrimSpace(mdUnescape(cells[2]))
			refTable, refCol := parseReference(refPart)
			fk := schema.ForeignKey{
				Name:             mdUnescape(cells[0]),
				Column:           strings.Trim(mdUnescape(cells[1]), "`"),
				ReferencedTable:  refTable,
				ReferencedColumn: refCol,
			}
			t.ForeignKeys = append(t.ForeignKeys, fk)
		}
	}

	return t, nil
}

// parseMarkdownRows splits markdown table content (already past the header
// separator line) into rows of trimmed cells.
func parseMarkdownRows(body string) [][]string {
	var result [][]string
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "|") || !strings.HasSuffix(line, "|") {
			continue
		}
		// Trim leading/trailing pipe, then split on |
		inner := line[1 : len(line)-1]
		rawCells := strings.Split(inner, "|")
		cells := make([]string, len(rawCells))
		for i, c := range rawCells {
			cells[i] = strings.TrimSpace(c)
		}
		result = append(result, cells)
	}
	return result
}

// parseReference parses the References column from the FK table.
// Input format: "`table`.`column`"
func parseReference(s string) (table, col string) {
	// Remove backticks and split on "."
	s = strings.ReplaceAll(s, "`", "")
	parts := strings.SplitN(s, ".", 2)
	if len(parts) == 2 {
		return strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
	}
	return s, ""
}

// mdUnescape reverses the pipe escaping applied by the writer.
func mdUnescape(s string) string {
	// The writer escapes "|" as "\|" in cell values. Unescape here.
	return strings.ReplaceAll(s, `\|`, "|")
}

