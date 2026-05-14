package schema

import "fmt"

// DiffKind describes the type of change.
type DiffKind string

const (
	DiffAdded    DiffKind = "added"
	DiffRemoved  DiffKind = "removed"
	DiffModified DiffKind = "modified"
)

// DiffEntry represents a single schema change.
type DiffEntry struct {
	Kind    DiffKind
	Table   string
	Detail  string // human-readable description
}

// Diff compares an old schema (from last sync) against a new schema (live DB)
// and returns a list of changes. Both inputs should have tables sorted by name
// for deterministic output.
func Diff(old, new []Table) []DiffEntry {
	oldMap := tableMap(old)
	newMap := tableMap(new)

	var entries []DiffEntry

	// Tables removed.
	for _, t := range old {
		if _, ok := newMap[t.Name]; !ok {
			entries = append(entries, DiffEntry{
				Kind:   DiffRemoved,
				Table:  t.Name,
				Detail: "table removed",
			})
		}
	}

	// Tables added.
	for _, t := range new {
		if _, ok := oldMap[t.Name]; !ok {
			entries = append(entries, DiffEntry{
				Kind:   DiffAdded,
				Table:  t.Name,
				Detail: fmt.Sprintf("table added (%d columns)", len(t.Columns)),
			})
		}
	}

	// Tables in both — compare columns, indexes, FKs.
	for _, newT := range new {
		oldT, ok := oldMap[newT.Name]
		if !ok {
			continue
		}
		entries = append(entries, diffColumns(oldT, newT)...)
		entries = append(entries, diffIndexes(oldT, newT)...)
		entries = append(entries, diffForeignKeys(oldT, newT)...)
	}

	return entries
}

func diffColumns(old, new Table) []DiffEntry {
	oldCols := columnMap(old.Columns)
	newCols := columnMap(new.Columns)
	var entries []DiffEntry

	for _, c := range old.Columns {
		if _, ok := newCols[c.Name]; !ok {
			entries = append(entries, DiffEntry{
				Kind:   DiffRemoved,
				Table:  old.Name,
				Detail: fmt.Sprintf("column %q removed", c.Name),
			})
		}
	}

	for _, c := range new.Columns {
		oc, ok := oldCols[c.Name]
		if !ok {
			entries = append(entries, DiffEntry{
				Kind:   DiffAdded,
				Table:  new.Name,
				Detail: fmt.Sprintf("column %q added (%s)", c.Name, c.Type),
			})
			continue
		}
		if changes := columnChanges(oc, c); changes != "" {
			entries = append(entries, DiffEntry{
				Kind:   DiffModified,
				Table:  new.Name,
				Detail: fmt.Sprintf("column %q changed: %s", c.Name, changes),
			})
		}
	}

	return entries
}

func columnChanges(old, new Column) string {
	var parts []string
	if old.Type != new.Type {
		parts = append(parts, fmt.Sprintf("type %s → %s", old.Type, new.Type))
	}
	if old.Nullable != new.Nullable {
		if new.Nullable {
			parts = append(parts, "now nullable")
		} else {
			parts = append(parts, "now NOT NULL")
		}
	}
	if ptrStr(old.Default) != ptrStr(new.Default) {
		parts = append(parts, fmt.Sprintf("default %s → %s", ptrStr(old.Default), ptrStr(new.Default)))
	}
	if old.Extra != new.Extra {
		parts = append(parts, fmt.Sprintf("extra %q → %q", old.Extra, new.Extra))
	}
	if len(parts) == 0 {
		return ""
	}
	result := parts[0]
	for _, p := range parts[1:] {
		result += ", " + p
	}
	return result
}

func diffIndexes(old, new Table) []DiffEntry {
	oldIdx := indexMap(old.Indexes)
	newIdx := indexMap(new.Indexes)
	var entries []DiffEntry

	for name := range oldIdx {
		if _, ok := newIdx[name]; !ok {
			entries = append(entries, DiffEntry{
				Kind:   DiffRemoved,
				Table:  old.Name,
				Detail: fmt.Sprintf("index %q removed", name),
			})
		}
	}
	for name := range newIdx {
		if _, ok := oldIdx[name]; !ok {
			entries = append(entries, DiffEntry{
				Kind:   DiffAdded,
				Table:  new.Name,
				Detail: fmt.Sprintf("index %q added", name),
			})
		}
	}

	return entries
}

func diffForeignKeys(old, new Table) []DiffEntry {
	oldFK := fkMap(old.ForeignKeys)
	newFK := fkMap(new.ForeignKeys)
	var entries []DiffEntry

	for name := range oldFK {
		if _, ok := newFK[name]; !ok {
			entries = append(entries, DiffEntry{
				Kind:   DiffRemoved,
				Table:  old.Name,
				Detail: fmt.Sprintf("foreign key %q removed", name),
			})
		}
	}
	for name := range newFK {
		if _, ok := oldFK[name]; !ok {
			entries = append(entries, DiffEntry{
				Kind:   DiffAdded,
				Table:  new.Name,
				Detail: fmt.Sprintf("foreign key %q added", name),
			})
		}
	}

	return entries
}

// ── helpers ──────────────────────────────────────────────────────────────────

func tableMap(tables []Table) map[string]Table {
	m := make(map[string]Table, len(tables))
	for _, t := range tables {
		m[t.Name] = t
	}
	return m
}

func columnMap(cols []Column) map[string]Column {
	m := make(map[string]Column, len(cols))
	for _, c := range cols {
		m[c.Name] = c
	}
	return m
}

func indexMap(idxs []Index) map[string]Index {
	m := make(map[string]Index, len(idxs))
	for _, i := range idxs {
		m[i.Name] = i
	}
	return m
}

func fkMap(fks []ForeignKey) map[string]ForeignKey {
	m := make(map[string]ForeignKey, len(fks))
	for _, fk := range fks {
		m[fk.Name] = fk
	}
	return m
}

func ptrStr(p *string) string {
	if p == nil {
		return "NULL"
	}
	return *p
}
