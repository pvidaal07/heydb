package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// supportedDrivers lists every driver value the CLI accepts.
var supportedDrivers = map[string]bool{
	"mysql": true,
}

// Config is the in-memory representation of .heydb/config.json.
type Config struct {
	Version          int                   `json:"version"`
	Connections      map[string]Connection `json:"connections"`
	ActiveConnection string                `json:"active_connection"`
}

// Connection holds credentials and address data for one database target.
type Connection struct {
	Driver   string `json:"driver"`            // "mysql"
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Database string `json:"database"`
	Username string `json:"username"`
	Password string `json:"password"`          // plaintext in MVP
	TLS      bool   `json:"tls"`
	Timeout  int    `json:"timeout_seconds"`
}

// Load reads and unmarshals config.json from the given path.
// It returns a default (empty) Config if the file does not exist yet.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return &Config{
			Version:     1,
			Connections: make(map[string]Connection),
		}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("config: read %s: %w", path, err)
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("config: parse %s: %w", path, err)
	}
	if cfg.Connections == nil {
		cfg.Connections = make(map[string]Connection)
	}
	return &cfg, nil
}

// Save marshals the Config and writes it atomically to path.
// Parent directories are created if they do not exist.
func Save(path string, cfg *Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("config: mkdir %s: %w", filepath.Dir(path), err)
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("config: marshal: %w", err)
	}

	// Write to a temp file first, then rename for atomicity.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("config: write tmp: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("config: rename to %s: %w", path, err)
	}
	return nil
}

// Validate checks that the Config contains no obviously invalid data.
// It does NOT verify connectivity.
func (c *Config) Validate() error {
	for name, conn := range c.Connections {
		if conn.Driver == "" {
			return fmt.Errorf("connection %q: driver is required", name)
		}
		if !supportedDrivers[conn.Driver] {
			return fmt.Errorf("connection %q: unknown driver %q (supported: mysql)", name, conn.Driver)
		}
		if conn.Host == "" {
			return fmt.Errorf("connection %q: host is required", name)
		}
		if conn.Port <= 0 || conn.Port > 65535 {
			return fmt.Errorf("connection %q: port must be 1–65535, got %d", name, conn.Port)
		}
		if conn.Database == "" {
			return fmt.Errorf("connection %q: database is required", name)
		}
		if conn.Username == "" {
			return fmt.Errorf("connection %q: username is required", name)
		}
	}

	if c.ActiveConnection != "" {
		if _, ok := c.Connections[c.ActiveConnection]; !ok {
			return fmt.Errorf("active_connection %q does not match any configured connection", c.ActiveConnection)
		}
	}

	return nil
}

// Active returns the active Connection and its name, or an error if none is set
// or the name does not exist in Connections.
func (c *Config) Active() (string, Connection, error) {
	if c.ActiveConnection == "" {
		return "", Connection{}, errors.New("no active connection — run `heydb connect` first")
	}
	conn, ok := c.Connections[c.ActiveConnection]
	if !ok {
		return "", Connection{}, fmt.Errorf(
			"active connection %q not found in config — run `heydb connect` to reconfigure",
			c.ActiveConnection,
		)
	}
	return c.ActiveConnection, conn, nil
}
