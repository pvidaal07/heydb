// Package sqlite provides SQLite-backed adapters for the heydb domain ports.
// This file contains GlobalStore — the single global store backed by
// ~/.heydb/heydb.db (or $HEYDB_HOME/heydb.db).
package sqlite

import (
	"context"
	cryptorand "crypto/rand"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite" // register driver

	"github.com/pvidaal07/heydb/internal/domain/ports"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// cryptoRandRead is an alias for crypto/rand.Read, allowing tests to substitute it.
var cryptoRandRead = cryptorand.Read

// Compile-time assertions: GlobalStore must satisfy all global ports.
var (
	_ ports.ProjectStore      = (*GlobalStore)(nil)
	_ ports.ConnectionStore   = (*GlobalStore)(nil)
	_ ports.AnnotationStore   = (*GlobalStore)(nil)
	_ ports.RelationshipStore = (*GlobalStore)(nil)
)

// globalDDL contains CREATE TABLE IF NOT EXISTS statements for all global tables.
// Each table is safe to run multiple times (idempotent via IF NOT EXISTS).
const globalDDL = `
CREATE TABLE IF NOT EXISTS user_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    repo_path  TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS connections (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name       TEXT NOT NULL,
    host       TEXT NOT NULL DEFAULT '',
    port       INTEGER NOT NULL DEFAULT 3306,
    database   TEXT NOT NULL DEFAULT '',
    user       TEXT NOT NULL DEFAULT '',
    password   TEXT NOT NULL DEFAULT '',
    is_active  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS annotations (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL,
    connection_name TEXT NOT NULL,
    target_type     TEXT NOT NULL,
    target_name     TEXT NOT NULL DEFAULT '',
    content         TEXT NOT NULL DEFAULT '',
    author          TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sync_chunks (
    chunk_id     TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL,
    direction    TEXT NOT NULL CHECK(direction IN ('imported', 'exported')),
    processed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Schema tables — scoped per connection_id (format: "project_id/connection_name")

CREATE TABLE IF NOT EXISTS schema_meta (
    connection_id TEXT PRIMARY KEY,
    database      TEXT NOT NULL DEFAULT '',
    schema_hash   TEXT NOT NULL DEFAULT '',
    synced_at     TEXT NOT NULL DEFAULT '',
    engine        TEXT NOT NULL DEFAULT '',
    version       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS schema_tables (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id TEXT NOT NULL,
    name          TEXT NOT NULL,
    engine        TEXT NOT NULL DEFAULT '',
    comment       TEXT NOT NULL DEFAULT '',
    UNIQUE(connection_id, name)
);

CREATE TABLE IF NOT EXISTS schema_columns (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id TEXT NOT NULL,
    table_name    TEXT NOT NULL,
    name          TEXT NOT NULL,
    ordinal_pos   INTEGER NOT NULL DEFAULT 0,
    type          TEXT NOT NULL DEFAULT '',
    nullable      INTEGER NOT NULL DEFAULT 0,
    col_default   TEXT,
    key_type      TEXT NOT NULL DEFAULT '',
    extra         TEXT NOT NULL DEFAULT '',
    comment       TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (connection_id, table_name) REFERENCES schema_tables(connection_id, name) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS schema_indexes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id TEXT NOT NULL,
    table_name    TEXT NOT NULL,
    name          TEXT NOT NULL,
    columns       TEXT NOT NULL DEFAULT '',
    is_unique     INTEGER NOT NULL DEFAULT 0,
    idx_type      TEXT NOT NULL DEFAULT 'BTREE',
    FOREIGN KEY (connection_id, table_name) REFERENCES schema_tables(connection_id, name) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS schema_foreign_keys (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id TEXT NOT NULL,
    table_name    TEXT NOT NULL,
    name          TEXT NOT NULL,
    column_name   TEXT NOT NULL DEFAULT '',
    ref_table     TEXT NOT NULL DEFAULT '',
    ref_column    TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (connection_id, table_name) REFERENCES schema_tables(connection_id, name) ON DELETE CASCADE
);

-- Implicit relationships — user-defined logical foreign keys not enforced by DB engine.
-- Scoped by project_id + connection_name (NOT connection_id) so they survive syncs.
CREATE TABLE IF NOT EXISTS implicit_relationships (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL,
    connection_name TEXT NOT NULL,
    from_table      TEXT NOT NULL,
    from_column     TEXT NOT NULL,
    to_table        TEXT NOT NULL,
    to_column       TEXT NOT NULL,
    label           TEXT NOT NULL DEFAULT '',
    author          TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_implicit_rel_from
  ON implicit_relationships(project_id, connection_name, from_table);

CREATE INDEX IF NOT EXISTS idx_implicit_rel_to
  ON implicit_relationships(project_id, connection_name, to_table);
`

// GlobalStore implements all global-scoped ports using a single SQLite file.
type GlobalStore struct {
	db     *sql.DB
	encKey []byte // AES-256 key for password encryption; derived in OpenGlobal
}

// OpenGlobal opens (or creates) the global SQLite database at the given path,
// enables WAL mode, and bootstraps the DDL.
func OpenGlobal(path string) (*GlobalStore, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("global: open %q: %w", path, err)
	}

	// Enable WAL mode before any DDL/DML.
	if _, err := db.Exec(`PRAGMA journal_mode=WAL`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("global: WAL pragma: %w", err)
	}

	// Enable foreign key enforcement.
	if _, err := db.Exec(`PRAGMA foreign_keys=ON`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("global: foreign_keys pragma: %w", err)
	}

	// Bootstrap all tables.
	if _, err := db.Exec(globalDDL); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("global: DDL bootstrap: %w", err)
	}

	// Derive encryption key: heydbDir is the directory that contains the DB file.
	// The salt file (key.salt) lives in the same directory.
	heydbDir := filepath.Dir(path)
	salt, err := ensureSalt(heydbDir)
	if err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("global: encryption key setup: %w", err)
	}
	hostname, err := os.Hostname()
	if err != nil {
		hostname = "localhost" // safe fallback — key stability is best-effort
	}
	encKey := deriveKey(hostname, salt)

	return &GlobalStore{db: db, encKey: encKey}, nil
}

// Close releases the underlying database connection. Safe to call multiple
// times (subsequent calls are no-ops).
func (g *GlobalStore) Close() error {
	if g.db != nil {
		return g.db.Close()
	}
	return nil
}

// DB exposes the underlying *sql.DB for tests that need to run raw queries
// (e.g., asserting that specific tables exist or checking PRAGMA values).
// Production code must not call this method.
func (g *GlobalStore) DB() *sql.DB {
	return g.db
}

// ── user_config ───────────────────────────────────────────────────────────────

// SetConfig upserts a key/value pair in user_config.
func (g *GlobalStore) SetConfig(ctx context.Context, key, value string) error {
	_, err := g.db.ExecContext(ctx,
		`INSERT INTO user_config (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		key, value)
	if err != nil {
		return fmt.Errorf("global: SetConfig %q: %w", key, err)
	}
	return nil
}

// GetConfig retrieves the value for a key from user_config.
// Returns ("", nil) if the key does not exist.
func (g *GlobalStore) GetConfig(ctx context.Context, key string) (string, error) {
	var value string
	err := g.db.QueryRowContext(ctx,
		`SELECT value FROM user_config WHERE key = ?`, key).Scan(&value)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("global: GetConfig %q: %w", key, err)
	}
	return value, nil
}

// ── ProjectStore ──────────────────────────────────────────────────────────────

// CreateProject inserts a new project row. Silently skips if a project with
// the same repo_path already exists (idempotent for `heydb init`).
func (g *GlobalStore) CreateProject(ctx context.Context, project schema.Project) error {
	_, err := g.db.ExecContext(ctx,
		`INSERT OR IGNORE INTO projects (id, name, repo_path) VALUES (?, ?, ?)`,
		project.ID, project.Name, project.RepoPath)
	if err != nil {
		return fmt.Errorf("global: CreateProject: %w", err)
	}
	return nil
}

// GetProjectByPath returns the project whose repo_path matches exactly.
// Returns (nil, nil) when no project is found.
func (g *GlobalStore) GetProjectByPath(ctx context.Context, repoPath string) (*schema.Project, error) {
	var p schema.Project
	err := g.db.QueryRowContext(ctx,
		`SELECT id, name, repo_path FROM projects WHERE repo_path = ?`, repoPath).
		Scan(&p.ID, &p.Name, &p.RepoPath)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("global: GetProjectByPath: %w", err)
	}
	return &p, nil
}

// GetProjectByID returns the project with the given UUID.
// Returns (nil, nil) when no project is found.
func (g *GlobalStore) GetProjectByID(ctx context.Context, id string) (*schema.Project, error) {
	var p schema.Project
	err := g.db.QueryRowContext(ctx,
		`SELECT id, name, repo_path FROM projects WHERE id = ?`, id).
		Scan(&p.ID, &p.Name, &p.RepoPath)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("global: GetProjectByID: %w", err)
	}
	return &p, nil
}

// ── ConnectionStore ───────────────────────────────────────────────────────────

// SaveConnection inserts or replaces a connection for the given project.
// A UUID is generated from the project_id + name combination as a stable ID.
// The password is encrypted with AES-256-GCM before storage.
func (g *GlobalStore) SaveConnection(ctx context.Context, projectID string, conn schema.Connection) error {
	cipherPW, err := encrypt(conn.Password, g.encKey)
	if err != nil {
		return fmt.Errorf("global: SaveConnection %q: encrypt password: %w", conn.Name, err)
	}

	connID := projectID + "/" + conn.Name
	_, err = g.db.ExecContext(ctx, `
		INSERT INTO connections (id, project_id, name, host, port, database, user, password, is_active)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(project_id, name) DO UPDATE SET
		    host      = excluded.host,
		    port      = excluded.port,
		    database  = excluded.database,
		    user      = excluded.user,
		    password  = excluded.password`,
		connID, projectID, conn.Name,
		conn.Host, conn.Port, conn.Database, conn.User, cipherPW,
		boolToInt(conn.Active),
	)
	if err != nil {
		return fmt.Errorf("global: SaveConnection %q: %w", conn.Name, err)
	}
	return nil
}

// GetConnection returns the connection with the given name for a project.
// Returns (nil, nil) when not found. The password is decrypted transparently.
//
// Lazy migration: if decryption fails, the stored value is assumed to be a
// legacy plaintext password. It is re-encrypted and written back so that
// subsequent reads use the encrypted path. This is a one-time migration per
// connection — after this call the row is always encrypted.
func (g *GlobalStore) GetConnection(ctx context.Context, projectID, name string) (*schema.Connection, error) {
	var c schema.Connection
	var active int
	var storedPW string
	err := g.db.QueryRowContext(ctx, `
		SELECT name, host, port, database, user, password, is_active, project_id
		FROM connections
		WHERE project_id = ? AND name = ?`,
		projectID, name).
		Scan(&c.Name, &c.Host, &c.Port, &c.Database, &c.User, &storedPW, &active, &c.ProjectID)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("global: GetConnection %q: %w", name, err)
	}
	c.Active = active == 1

	plainPW, err := decrypt(storedPW, g.encKey)
	if err != nil {
		// Decryption failure — could be a legacy plaintext password or truly corrupt data.
		// Distinguish by attempting base64 decode: if it fails, it's definitely plaintext.
		// If base64 succeeds but GCM fails, it could still be coincidentally-valid-b64 plaintext
		// or genuinely corrupted. We re-try with a corruption-detection heuristic:
		// a valid GCM ciphertext must be at least nonce (12 bytes) + tag (16 bytes) = 28 bytes
		// after base64 decode, and the stored value must look like base64 (no spaces, etc.).
		// If the stored value is short or looks like a human password, treat as plaintext.
		if isLikelyPlaintext(storedPW) {
			// Lazy migration: re-encrypt and write back.
			plainPW = storedPW
			if reencErr := g.reencryptPassword(ctx, projectID, name, plainPW); reencErr != nil {
				// Non-fatal: migration failed but we can still return the plaintext.
				// Next read will retry migration.
				_ = reencErr
			}
		} else {
			// Looks like it was meant to be encrypted but is corrupted.
			return nil, fmt.Errorf("global: GetConnection %q: %w", name, err)
		}
	}

	c.Password = plainPW
	return &c, nil
}

// reencryptPassword writes an encrypted version of plainPW back to the DB row,
// completing lazy migration for a connection that was stored as plaintext.
func (g *GlobalStore) reencryptPassword(ctx context.Context, projectID, name, plainPW string) error {
	cipherPW, err := encrypt(plainPW, g.encKey)
	if err != nil {
		return fmt.Errorf("global: reencryptPassword %q: %w", name, err)
	}
	_, err = g.db.ExecContext(ctx,
		`UPDATE connections SET password = ? WHERE project_id = ? AND name = ?`,
		cipherPW, projectID, name)
	return err
}

// isLikelyPlaintext returns true when s is almost certainly a human-typed
// password rather than an AES-256-GCM ciphertext encoded as base64.
//
// Heuristic: a valid ciphertext base64-decodes to at least 28 bytes (12-byte
// nonce + 16-byte GCM tag, with zero plaintext). If s fails base64 decoding
// OR the decoded length is below 28 bytes, it cannot be a valid ciphertext —
// treat it as plaintext. This covers the common case of short passwords and
// passwords with non-base64 characters (spaces, @, etc.).
func isLikelyPlaintext(s string) bool {
	raw, err := decodeBase64(s)
	if err != nil {
		return true // cannot be base64-encoded ciphertext
	}
	return len(raw) < 28 // too short to be a valid GCM ciphertext
}

// ListConnections returns all connections for a project, ordered by name.
// Passwords are decrypted transparently. Rows with legacy plaintext passwords
// are migrated lazily (re-encrypted and written back) on first read.
func (g *GlobalStore) ListConnections(ctx context.Context, projectID string) ([]schema.Connection, error) {
	rows, err := g.db.QueryContext(ctx, `
		SELECT name, host, port, database, user, password, is_active, project_id
		FROM connections
		WHERE project_id = ?
		ORDER BY name`,
		projectID)
	if err != nil {
		return nil, fmt.Errorf("global: ListConnections: %w", err)
	}
	defer rows.Close()

	var result []schema.Connection
	for rows.Next() {
		var c schema.Connection
		var active int
		var storedPW string
		if err := rows.Scan(&c.Name, &c.Host, &c.Port, &c.Database, &c.User, &storedPW, &active, &c.ProjectID); err != nil {
			return nil, fmt.Errorf("global: ListConnections scan: %w", err)
		}
		c.Active = active == 1

		plainPW, decErr := decrypt(storedPW, g.encKey)
		if decErr != nil {
			if isLikelyPlaintext(storedPW) {
				// Lazy migration: re-encrypt and write back.
				plainPW = storedPW
				_ = g.reencryptPassword(ctx, projectID, c.Name, plainPW)
			} else {
				return nil, fmt.Errorf("global: ListConnections decrypt %q: %w", c.Name, decErr)
			}
		}
		c.Password = plainPW
		result = append(result, c)
	}
	return result, rows.Err()
}

// SetActive marks the named connection as active and clears active on all others
// in the same project.
func (g *GlobalStore) SetActive(ctx context.Context, projectID, name string) error {
	tx, err := g.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("global: SetActive begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// Clear all active flags for this project.
	if _, err := tx.ExecContext(ctx,
		`UPDATE connections SET is_active = 0 WHERE project_id = ?`, projectID); err != nil {
		return fmt.Errorf("global: SetActive clear: %w", err)
	}

	// Set the named connection active.
	res, err := tx.ExecContext(ctx,
		`UPDATE connections SET is_active = 1 WHERE project_id = ? AND name = ?`,
		projectID, name)
	if err != nil {
		return fmt.Errorf("global: SetActive set: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("global: SetActive: connection %q not found in project %q", name, projectID)
	}

	return tx.Commit()
}

// DeleteConnection removes a connection by project and name.
func (g *GlobalStore) DeleteConnection(ctx context.Context, projectID, name string) error {
	_, err := g.db.ExecContext(ctx,
		`DELETE FROM connections WHERE project_id = ? AND name = ?`,
		projectID, name)
	if err != nil {
		return fmt.Errorf("global: DeleteConnection %q: %w", name, err)
	}
	return nil
}

// ── AnnotationStore ───────────────────────────────────────────────────────────

// newUUID generates a random UUID v4 using crypto/rand.
func newUUID() (string, error) {
	var b [16]byte
	if _, err := cryptoRandRead(b[:]); err != nil {
		return "", fmt.Errorf("uuid: rand read: %w", err)
	}
	// Set version (4) and variant bits per RFC 4122.
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// AddAnnotation inserts a new annotation row. If ann.ID is empty, a UUID v4 is
// generated. created_at and updated_at are set to now.
func (g *GlobalStore) AddAnnotation(ctx context.Context, ann schema.Annotation) (schema.Annotation, error) {
	if strings.TrimSpace(ann.Author) == "" {
		return ann, fmt.Errorf("global: AddAnnotation: author is required")
	}
	if ann.ID == "" {
		id, err := newUUID()
		if err != nil {
			return ann, fmt.Errorf("global: AddAnnotation generate UUID: %w", err)
		}
		ann.ID = id
	}
	now := time.Now().UTC()
	ann.CreatedAt = now
	ann.UpdatedAt = now

	_, err := g.db.ExecContext(ctx, `
		INSERT INTO annotations (id, project_id, connection_name, target_type, target_name, content, author, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		ann.ID, ann.ProjectID, ann.ConnectionName, ann.TargetType, ann.TargetName,
		ann.Content, ann.Author,
		ann.CreatedAt.UTC().Format(time.RFC3339),
		ann.UpdatedAt.UTC().Format(time.RFC3339),
	)
	if err != nil {
		return ann, fmt.Errorf("global: AddAnnotation: %w", err)
	}
	return ann, nil
}

// GetAnnotations returns all annotations for the given project, connection,
// target type, and target name.
func (g *GlobalStore) GetAnnotations(ctx context.Context, projectID, connectionName, targetType, targetName string) ([]schema.Annotation, error) {
	rows, err := g.db.QueryContext(ctx, `
		SELECT id, project_id, connection_name, target_type, target_name, content, author, created_at, updated_at
		FROM annotations
		WHERE project_id = ? AND connection_name = ? AND target_type = ? AND target_name = ?
		ORDER BY created_at`,
		projectID, connectionName, targetType, targetName)
	if err != nil {
		return nil, fmt.Errorf("global: GetAnnotations: %w", err)
	}
	defer rows.Close()
	return scanAnnotations(rows)
}

// GetAllAnnotations returns every annotation for a project/connection pair.
func (g *GlobalStore) GetAllAnnotations(ctx context.Context, projectID, connectionName string) ([]schema.Annotation, error) {
	rows, err := g.db.QueryContext(ctx, `
		SELECT id, project_id, connection_name, target_type, target_name, content, author, created_at, updated_at
		FROM annotations
		WHERE project_id = ? AND connection_name = ?
		ORDER BY created_at`,
		projectID, connectionName)
	if err != nil {
		return nil, fmt.Errorf("global: GetAllAnnotations: %w", err)
	}
	defer rows.Close()
	return scanAnnotations(rows)
}

// EditAnnotation updates the content and updated_at of the annotation with id.
// Returns an error if the annotation does not exist.
func (g *GlobalStore) EditAnnotation(ctx context.Context, id, newContent string) (schema.Annotation, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	res, err := g.db.ExecContext(ctx,
		`UPDATE annotations SET content = ?, updated_at = ? WHERE id = ?`,
		newContent, now, id)
	if err != nil {
		return schema.Annotation{}, fmt.Errorf("global: EditAnnotation: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return schema.Annotation{}, fmt.Errorf("global: EditAnnotation: annotation %q not found", id)
	}
	return g.loadAnnotationByID(ctx, id)
}

// DeleteAnnotation removes the annotation with the given UUID.
// Returns an error if the annotation does not exist.
func (g *GlobalStore) DeleteAnnotation(ctx context.Context, id string) error {
	res, err := g.db.ExecContext(ctx, `DELETE FROM annotations WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("global: DeleteAnnotation: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("global: DeleteAnnotation: annotation %q not found", id)
	}
	return nil
}

// GetAnnotationsSince returns all annotations for a project whose updated_at
// is strictly after since. Used by heydb push.
func (g *GlobalStore) GetAnnotationsSince(ctx context.Context, projectID string, since time.Time) ([]schema.Annotation, error) {
	rows, err := g.db.QueryContext(ctx, `
		SELECT id, project_id, connection_name, target_type, target_name, content, author, created_at, updated_at
		FROM annotations
		WHERE project_id = ? AND updated_at > ?
		ORDER BY updated_at`,
		projectID, since.UTC().Format(time.RFC3339))
	if err != nil {
		return nil, fmt.Errorf("global: GetAnnotationsSince: %w", err)
	}
	defer rows.Close()
	return scanAnnotations(rows)
}

// ImportAnnotations bulk-inserts annotations using ON CONFLICT(id) DO UPDATE
// so that re-importing the same UUID updates the content (idempotent).
func (g *GlobalStore) ImportAnnotations(ctx context.Context, annotations []schema.Annotation) error {
	tx, err := g.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("global: ImportAnnotations begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	for _, ann := range annotations {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO annotations (id, project_id, connection_name, target_type, target_name, content, author, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
			    content    = excluded.content,
			    updated_at = excluded.updated_at`,
			ann.ID, ann.ProjectID, ann.ConnectionName, ann.TargetType, ann.TargetName,
			ann.Content, ann.Author,
			ann.CreatedAt.UTC().Format(time.RFC3339),
			ann.UpdatedAt.UTC().Format(time.RFC3339),
		)
		if err != nil {
			return fmt.Errorf("global: ImportAnnotations insert %q: %w", ann.ID, err)
		}
	}
	return tx.Commit()
}

// ── Annotation helpers ────────────────────────────────────────────────────────

func (g *GlobalStore) loadAnnotationByID(ctx context.Context, id string) (schema.Annotation, error) {
	row := g.db.QueryRowContext(ctx, `
		SELECT id, project_id, connection_name, target_type, target_name, content, author, created_at, updated_at
		FROM annotations WHERE id = ?`, id)
	var ann schema.Annotation
	var createdAt, updatedAt string
	err := row.Scan(
		&ann.ID, &ann.ProjectID, &ann.ConnectionName,
		&ann.TargetType, &ann.TargetName, &ann.Content, &ann.Author,
		&createdAt, &updatedAt,
	)
	if err == sql.ErrNoRows {
		return ann, fmt.Errorf("global: annotation %q not found", id)
	}
	if err != nil {
		return ann, fmt.Errorf("global: loadAnnotationByID: %w", err)
	}
	if t, err := time.Parse(time.RFC3339, createdAt); err == nil {
		ann.CreatedAt = t
	}
	if t, err := time.Parse(time.RFC3339, updatedAt); err == nil {
		ann.UpdatedAt = t
	}
	return ann, nil
}

func scanAnnotations(rows *sql.Rows) ([]schema.Annotation, error) {
	var result []schema.Annotation
	for rows.Next() {
		var ann schema.Annotation
		var createdAt, updatedAt string
		if err := rows.Scan(
			&ann.ID, &ann.ProjectID, &ann.ConnectionName,
			&ann.TargetType, &ann.TargetName, &ann.Content, &ann.Author,
			&createdAt, &updatedAt,
		); err != nil {
			return nil, fmt.Errorf("global: scanAnnotations: %w", err)
		}
		if t, err := time.Parse(time.RFC3339, createdAt); err == nil {
			ann.CreatedAt = t
		}
		if t, err := time.Parse(time.RFC3339, updatedAt); err == nil {
			ann.UpdatedAt = t
		}
		result = append(result, ann)
	}
	if result == nil {
		result = []schema.Annotation{}
	}
	return result, rows.Err()
}

// ── RelationshipStore ─────────────────────────────────────────────────────────

// AddRelationship inserts a new implicit relationship. Author must be non-empty.
// Duplicate from_table/from_column/to_table/to_column tuples per project+connection
// are rejected. A UUID is generated if rel.ID is empty.
func (g *GlobalStore) AddRelationship(ctx context.Context, rel schema.ImplicitRelationship) (schema.ImplicitRelationship, error) {
	if strings.TrimSpace(rel.Author) == "" {
		return rel, fmt.Errorf("global: AddRelationship: author is required")
	}
	if rel.ID == "" {
		id, err := newUUID()
		if err != nil {
			return rel, fmt.Errorf("global: AddRelationship generate UUID: %w", err)
		}
		rel.ID = id
	}

	// Check for duplicate (same from+to tuple within project+connection).
	var count int
	err := g.db.QueryRowContext(ctx, `
		SELECT COUNT(1) FROM implicit_relationships
		WHERE project_id = ? AND connection_name = ?
		  AND from_table = ? AND from_column = ?
		  AND to_table   = ? AND to_column   = ?`,
		rel.ProjectID, rel.ConnectionName,
		rel.FromTable, rel.FromColumn,
		rel.ToTable, rel.ToColumn,
	).Scan(&count)
	if err != nil {
		return rel, fmt.Errorf("global: AddRelationship duplicate check: %w", err)
	}
	if count > 0 {
		return rel, fmt.Errorf("global: AddRelationship: relationship %s.%s → %s.%s already exists for connection %q",
			rel.FromTable, rel.FromColumn, rel.ToTable, rel.ToColumn, rel.ConnectionName)
	}

	now := time.Now().UTC()
	rel.CreatedAt = now

	_, err = g.db.ExecContext(ctx, `
		INSERT INTO implicit_relationships
		    (id, project_id, connection_name, from_table, from_column, to_table, to_column, label, author, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		rel.ID, rel.ProjectID, rel.ConnectionName,
		rel.FromTable, rel.FromColumn,
		rel.ToTable, rel.ToColumn,
		rel.Label, rel.Author,
		rel.CreatedAt.UTC().Format(time.RFC3339),
	)
	if err != nil {
		return rel, fmt.Errorf("global: AddRelationship insert: %w", err)
	}
	return rel, nil
}

// DeleteRelationship removes the implicit relationship with the given UUID.
// Returns an error if the UUID does not exist.
func (g *GlobalStore) DeleteRelationship(ctx context.Context, id string) error {
	res, err := g.db.ExecContext(ctx,
		`DELETE FROM implicit_relationships WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("global: DeleteRelationship: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("global: DeleteRelationship: relationship %q not found", id)
	}
	return nil
}

// ListRelationships returns all implicit relationships for the given project+connection,
// ordered by created_at.
func (g *GlobalStore) ListRelationships(ctx context.Context, projectID, connectionName string) ([]schema.ImplicitRelationship, error) {
	rows, err := g.db.QueryContext(ctx, `
		SELECT id, project_id, connection_name, from_table, from_column,
		       to_table, to_column, label, author, created_at
		FROM implicit_relationships
		WHERE project_id = ? AND connection_name = ?
		ORDER BY created_at`,
		projectID, connectionName)
	if err != nil {
		return nil, fmt.Errorf("global: ListRelationships: %w", err)
	}
	defer rows.Close()
	return scanRelationships(rows)
}

// GetRelationshipsByTable returns all implicit relationships where tableName
// appears as either from_table OR to_table (bidirectional read).
func (g *GlobalStore) GetRelationshipsByTable(ctx context.Context, projectID, connectionName, tableName string) ([]schema.ImplicitRelationship, error) {
	rows, err := g.db.QueryContext(ctx, `
		SELECT id, project_id, connection_name, from_table, from_column,
		       to_table, to_column, label, author, created_at
		FROM implicit_relationships
		WHERE project_id = ? AND connection_name = ?
		  AND (from_table = ? OR to_table = ?)
		ORDER BY created_at`,
		projectID, connectionName, tableName, tableName)
	if err != nil {
		return nil, fmt.Errorf("global: GetRelationshipsByTable %q: %w", tableName, err)
	}
	defer rows.Close()
	return scanRelationships(rows)
}

// ── Relationship helpers ──────────────────────────────────────────────────────

func scanRelationships(rows *sql.Rows) ([]schema.ImplicitRelationship, error) {
	var result []schema.ImplicitRelationship
	for rows.Next() {
		var r schema.ImplicitRelationship
		var createdAt string
		if err := rows.Scan(
			&r.ID, &r.ProjectID, &r.ConnectionName,
			&r.FromTable, &r.FromColumn,
			&r.ToTable, &r.ToColumn,
			&r.Label, &r.Author, &createdAt,
		); err != nil {
			return nil, fmt.Errorf("global: scanRelationships: %w", err)
		}
		if t, err := time.Parse(time.RFC3339, createdAt); err == nil {
			r.CreatedAt = t
		}
		result = append(result, r)
	}
	if result == nil {
		result = []schema.ImplicitRelationship{}
	}
	return result, rows.Err()
}

// ── SyncChunks ────────────────────────────────────────────────────────────────

// MarkChunkImported records that a chunk has been imported into this store.
func (g *GlobalStore) MarkChunkImported(ctx context.Context, chunkID, projectID string) error {
	_, err := g.db.ExecContext(ctx, `
		INSERT INTO sync_chunks (chunk_id, project_id, direction, processed_at)
		VALUES (?, ?, 'imported', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
		ON CONFLICT(chunk_id) DO NOTHING`,
		chunkID, projectID)
	if err != nil {
		return fmt.Errorf("global: MarkChunkImported %q: %w", chunkID, err)
	}
	return nil
}

// MarkChunkExported records that a chunk has been exported from this store.
func (g *GlobalStore) MarkChunkExported(ctx context.Context, chunkID, projectID string) error {
	_, err := g.db.ExecContext(ctx, `
		INSERT INTO sync_chunks (chunk_id, project_id, direction, processed_at)
		VALUES (?, ?, 'exported', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
		ON CONFLICT(chunk_id) DO NOTHING`,
		chunkID, projectID)
	if err != nil {
		return fmt.Errorf("global: MarkChunkExported %q: %w", chunkID, err)
	}
	return nil
}

// IsChunkImported returns true if the given chunk_id is already recorded as imported.
func (g *GlobalStore) IsChunkImported(ctx context.Context, chunkID string) (bool, error) {
	var count int
	err := g.db.QueryRowContext(ctx, `
		SELECT COUNT(1) FROM sync_chunks WHERE chunk_id = ? AND direction = 'imported'`,
		chunkID).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("global: IsChunkImported %q: %w", chunkID, err)
	}
	return count > 0, nil
}

// LatestExportedAt returns the processed_at timestamp of the most recently exported
// chunk for the given project. Returns a zero time.Time if no exports exist yet.
func (g *GlobalStore) LatestExportedAt(ctx context.Context, projectID string) (time.Time, error) {
	var ts string
	err := g.db.QueryRowContext(ctx, `
		SELECT processed_at FROM sync_chunks
		WHERE project_id = ? AND direction = 'exported'
		ORDER BY processed_at DESC
		LIMIT 1`,
		projectID).Scan(&ts)
	if err == sql.ErrNoRows {
		return time.Time{}, nil
	}
	if err != nil {
		return time.Time{}, fmt.Errorf("global: LatestExportedAt: %w", err)
	}
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return time.Time{}, fmt.Errorf("global: LatestExportedAt parse: %w", err)
	}
	return t, nil
}

// ── SchemaStore (scoped per connection) ───────────────────────────────────────

// ForConnection returns a ConnSchemaStore scoped to the given connection ID.
// The connID is typically "projectID/connectionName" (the same format used as
// the connections.id primary key).
func (g *GlobalStore) ForConnection(connID string) *ConnSchemaStore {
	return &ConnSchemaStore{db: g.db, connID: connID}
}

// ConnSchemaStore implements ports.SchemaStore for a single connection inside
// the global heydb.db. All rows are scoped by connection_id.
type ConnSchemaStore struct {
	db     *sql.DB
	connID string
}

// Compile-time assertion: ConnSchemaStore must satisfy ports.SchemaStore.
var _ ports.SchemaStore = (*ConnSchemaStore)(nil)

// SaveSchema replaces all existing schema rows for this connection and writes
// the provided schema from scratch — inside a single transaction.
func (c *ConnSchemaStore) SaveSchema(ctx context.Context, sc schema.Schema) error {
	tx, err := c.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("conn-schema: SaveSchema begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// Delete existing data for this connection (cascade handles child rows).
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM schema_tables WHERE connection_id = ?`, c.connID); err != nil {
		return fmt.Errorf("conn-schema: delete schema_tables: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM schema_meta WHERE connection_id = ?`, c.connID); err != nil {
		return fmt.Errorf("conn-schema: delete schema_meta: %w", err)
	}

	// Insert meta row.
	_, err = tx.ExecContext(ctx, `
		INSERT INTO schema_meta (connection_id, database, schema_hash, synced_at, engine, version)
		VALUES (?, ?, ?, ?, ?, ?)`,
		c.connID, sc.Database, sc.Hash,
		sc.SyncedAt.UTC().Format(time.RFC3339),
		sc.Engine, sc.Version,
	)
	if err != nil {
		return fmt.Errorf("conn-schema: insert schema_meta: %w", err)
	}

	for _, t := range sc.Tables {
		if err := insertGlobalTable(ctx, tx, c.connID, t); err != nil {
			return err
		}
	}

	return tx.Commit()
}

// LoadSchema returns the full schema for this connection from the global DB.
func (c *ConnSchemaStore) LoadSchema(ctx context.Context) (schema.Schema, error) {
	var sc schema.Schema

	row := c.db.QueryRowContext(ctx, `
		SELECT database, schema_hash, synced_at, engine, version
		FROM schema_meta WHERE connection_id = ?`, c.connID)
	var syncedAtStr string
	if err := row.Scan(&sc.Database, &sc.Hash, &syncedAtStr, &sc.Engine, &sc.Version); err != nil {
		return sc, fmt.Errorf("conn-schema: LoadSchema meta: %w", err)
	}
	if t, err := time.Parse(time.RFC3339, syncedAtStr); err == nil {
		sc.SyncedAt = t
	}

	rows, err := c.db.QueryContext(ctx, `
		SELECT name, engine, comment FROM schema_tables
		WHERE connection_id = ? ORDER BY name`, c.connID)
	if err != nil {
		return sc, fmt.Errorf("conn-schema: LoadSchema tables: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var name, eng, comment string
		if err := rows.Scan(&name, &eng, &comment); err != nil {
			return sc, err
		}
		t, err := c.loadTableByName(ctx, name)
		if err != nil {
			return sc, err
		}
		t.Engine = eng
		t.Comment = comment
		sc.Tables = append(sc.Tables, t)
	}
	return sc, rows.Err()
}

// GetTable returns a single table by exact name for this connection.
func (c *ConnSchemaStore) GetTable(ctx context.Context, name string) (schema.Table, error) {
	var exists int
	if err := c.db.QueryRowContext(ctx,
		`SELECT COUNT(1) FROM schema_tables WHERE connection_id = ? AND name = ?`,
		c.connID, name).Scan(&exists); err != nil {
		return schema.Table{}, fmt.Errorf("conn-schema: GetTable check: %w", err)
	}
	if exists == 0 {
		return schema.Table{}, fmt.Errorf("conn-schema: table %q not found", name)
	}

	t, err := c.loadTableByName(ctx, name)
	if err != nil {
		return schema.Table{}, err
	}

	var eng, comment string
	_ = c.db.QueryRowContext(ctx,
		`SELECT engine, comment FROM schema_tables WHERE connection_id = ? AND name = ?`,
		c.connID, name).Scan(&eng, &comment)
	t.Engine = eng
	t.Comment = comment
	return t, nil
}

// SearchTables performs a case-insensitive substring search across table names,
// column names, comment fields, annotation content, and implicit relationship
// table/column names for this connection.
//
// When projectID and connectionName are non-empty, the search also queries:
//   - annotation content (annotations table)
//   - implicit relationship from_table, from_column, to_table, to_column
//     (implicit_relationships table)
//
// Results are deduplicated by table name using a map. Passing empty strings
// for projectID/connectionName skips the annotation/relationship sources
// (e.g. CLI and TUI paths which do not have project context).
func (c *ConnSchemaStore) SearchTables(ctx context.Context, query, projectID, connectionName string) ([]schema.Table, error) {
	like := "%" + query + "%"

	// ── 1. Schema-level search (table/column names and comments) ─────────────
	schemaRows, err := c.db.QueryContext(ctx, `
		SELECT DISTINCT st.name
		FROM schema_tables st
		LEFT JOIN schema_columns sc ON sc.connection_id = st.connection_id AND sc.table_name = st.name
		WHERE st.connection_id = ?
		  AND (st.name    LIKE ? COLLATE NOCASE
		    OR st.comment LIKE ? COLLATE NOCASE
		    OR sc.name    LIKE ? COLLATE NOCASE
		    OR sc.comment LIKE ? COLLATE NOCASE)
		ORDER BY st.name`,
		c.connID, like, like, like, like)
	if err != nil {
		return nil, fmt.Errorf("conn-schema: SearchTables schema query: %w", err)
	}
	defer schemaRows.Close()

	// Use an ordered slice + seen map to preserve consistent ordering while deduping.
	seen := make(map[string]bool)
	var orderedNames []string

	for schemaRows.Next() {
		var name string
		if err := schemaRows.Scan(&name); err != nil {
			return nil, err
		}
		if !seen[name] {
			seen[name] = true
			orderedNames = append(orderedNames, name)
		}
	}
	if err := schemaRows.Err(); err != nil {
		return nil, err
	}

	// ── 2. Annotation content search ─────────────────────────────────────────
	if projectID != "" && connectionName != "" {
		annRows, err := c.db.QueryContext(ctx, `
			SELECT DISTINCT target_name
			FROM annotations
			WHERE project_id = ? AND connection_name = ?
			  AND target_type = 'table'
			  AND content LIKE ? COLLATE NOCASE`,
			projectID, connectionName, like)
		if err != nil {
			return nil, fmt.Errorf("conn-schema: SearchTables annotation query: %w", err)
		}
		defer annRows.Close()

		for annRows.Next() {
			var name string
			if err := annRows.Scan(&name); err != nil {
				return nil, err
			}
			if !seen[name] {
				seen[name] = true
				orderedNames = append(orderedNames, name)
			}
		}
		if err := annRows.Err(); err != nil {
			return nil, err
		}

		// ── 3. Implicit relationship search ───────────────────────────────────
		relRows, err := c.db.QueryContext(ctx, `
			SELECT from_table, to_table
			FROM implicit_relationships
			WHERE project_id = ? AND connection_name = ?
			  AND (from_table  LIKE ? COLLATE NOCASE
			    OR from_column LIKE ? COLLATE NOCASE
			    OR to_table    LIKE ? COLLATE NOCASE
			    OR to_column   LIKE ? COLLATE NOCASE)`,
			projectID, connectionName, like, like, like, like)
		if err != nil {
			return nil, fmt.Errorf("conn-schema: SearchTables relationship query: %w", err)
		}
		defer relRows.Close()

		for relRows.Next() {
			var fromTable, toTable string
			if err := relRows.Scan(&fromTable, &toTable); err != nil {
				return nil, err
			}
			for _, name := range []string{fromTable, toTable} {
				if name != "" && !seen[name] {
					seen[name] = true
					orderedNames = append(orderedNames, name)
				}
			}
		}
		if err := relRows.Err(); err != nil {
			return nil, err
		}
	}

	// ── 4. Load full table data for each unique name ──────────────────────────
	result := make([]schema.Table, 0, len(orderedNames))
	for _, name := range orderedNames {
		t, err := c.GetTable(ctx, name)
		if err != nil {
			// Table may not exist in schema (e.g. relationship references deleted table).
			// Skip gracefully rather than returning an error.
			continue
		}
		result = append(result, t)
	}

	return result, nil
}

// Close is a no-op: ConnSchemaStore does not own the underlying *sql.DB.
// The GlobalStore that created this instance owns the connection lifecycle.
func (c *ConnSchemaStore) Close() error { return nil }

// ── ConnSchemaStore helpers ───────────────────────────────────────────────────

func insertGlobalTable(ctx context.Context, tx *sql.Tx, connID string, t schema.Table) error {
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_tables (connection_id, name, engine, comment) VALUES (?, ?, ?, ?)`,
		connID, t.Name, t.Engine, t.Comment); err != nil {
		return fmt.Errorf("conn-schema: insert schema_tables %q: %w", t.Name, err)
	}

	for _, col := range t.Columns {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO schema_columns
			    (connection_id, table_name, name, ordinal_pos, type, nullable, col_default, key_type, extra, comment)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			connID, t.Name, col.Name, col.OrdinalPos, col.Type,
			boolToInt(col.Nullable), col.Default, col.Key, col.Extra, col.Comment); err != nil {
			return fmt.Errorf("conn-schema: insert schema_columns %q.%q: %w", t.Name, col.Name, err)
		}
	}

	for _, idx := range t.Indexes {
		colsStr := strings.Join(idx.Columns, ",")
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO schema_indexes (connection_id, table_name, name, columns, is_unique, idx_type)
			VALUES (?, ?, ?, ?, ?, ?)`,
			connID, t.Name, idx.Name, colsStr, boolToInt(idx.Unique), idx.Type); err != nil {
			return fmt.Errorf("conn-schema: insert schema_indexes %q.%q: %w", t.Name, idx.Name, err)
		}
	}

	for _, fk := range t.ForeignKeys {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO schema_foreign_keys (connection_id, table_name, name, column_name, ref_table, ref_column)
			VALUES (?, ?, ?, ?, ?, ?)`,
			connID, t.Name, fk.Name, fk.Column, fk.ReferencedTable, fk.ReferencedColumn); err != nil {
			return fmt.Errorf("conn-schema: insert schema_foreign_keys %q.%q: %w", t.Name, fk.Name, err)
		}
	}

	return nil
}

func (c *ConnSchemaStore) loadTableByName(ctx context.Context, name string) (schema.Table, error) {
	t := schema.Table{Name: name}

	// Columns.
	colRows, err := c.db.QueryContext(ctx, `
		SELECT name, ordinal_pos, type, nullable, col_default, key_type, extra, comment
		FROM   schema_columns
		WHERE  connection_id = ? AND table_name = ?
		ORDER  BY ordinal_pos`, c.connID, name)
	if err != nil {
		return t, fmt.Errorf("conn-schema: load columns for %q: %w", name, err)
	}
	defer colRows.Close()

	for colRows.Next() {
		var col schema.Column
		var nullable int
		var def sql.NullString
		if err := colRows.Scan(
			&col.Name, &col.OrdinalPos, &col.Type,
			&nullable, &def, &col.Key, &col.Extra, &col.Comment,
		); err != nil {
			return t, err
		}
		col.Nullable = nullable == 1
		if def.Valid {
			v := def.String
			col.Default = &v
		}
		t.Columns = append(t.Columns, col)
		if col.Key == "PRI" {
			t.PrimaryKey = append(t.PrimaryKey, col.Name)
		}
	}
	if err := colRows.Err(); err != nil {
		return t, err
	}

	// Indexes.
	idxRows, err := c.db.QueryContext(ctx, `
		SELECT name, columns, is_unique, idx_type
		FROM   schema_indexes
		WHERE  connection_id = ? AND table_name = ?
		ORDER  BY name`, c.connID, name)
	if err != nil {
		return t, fmt.Errorf("conn-schema: load indexes for %q: %w", name, err)
	}
	defer idxRows.Close()

	for idxRows.Next() {
		var idx schema.Index
		var colsStr string
		var unique int
		if err := idxRows.Scan(&idx.Name, &colsStr, &unique, &idx.Type); err != nil {
			return t, err
		}
		idx.Unique = unique == 1
		if colsStr != "" {
			idx.Columns = strings.Split(colsStr, ",")
		}
		t.Indexes = append(t.Indexes, idx)
	}
	if err := idxRows.Err(); err != nil {
		return t, err
	}

	// Foreign keys.
	fkRows, err := c.db.QueryContext(ctx, `
		SELECT name, column_name, ref_table, ref_column
		FROM   schema_foreign_keys
		WHERE  connection_id = ? AND table_name = ?
		ORDER  BY name`, c.connID, name)
	if err != nil {
		return t, fmt.Errorf("conn-schema: load fks for %q: %w", name, err)
	}
	defer fkRows.Close()

	for fkRows.Next() {
		var fk schema.ForeignKey
		if err := fkRows.Scan(&fk.Name, &fk.Column, &fk.ReferencedTable, &fk.ReferencedColumn); err != nil {
			return t, err
		}
		t.ForeignKeys = append(t.ForeignKeys, fk)
	}
	return t, fkRows.Err()
}
