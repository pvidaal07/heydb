package config_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/pvidaal07/heydb/internal/config"
)

func TestValidate_MissingDriver(t *testing.T) {
	cfg := &config.Config{
		Version: 1,
		Connections: map[string]config.Connection{
			"main": {Driver: "", Host: "localhost", Port: 3306, Database: "app", Username: "root"},
		},
	}
	if err := cfg.Validate(); err == nil {
		t.Error("expected error for missing driver, got nil")
	}
}

func TestValidate_UnknownDriver(t *testing.T) {
	cfg := &config.Config{
		Version: 1,
		Connections: map[string]config.Connection{
			"main": {Driver: "postgres", Host: "localhost", Port: 5432, Database: "app", Username: "root"},
		},
	}
	err := cfg.Validate()
	if err == nil {
		t.Error("expected error for unknown driver, got nil")
	}
}

func TestValidate_MissingHost(t *testing.T) {
	cfg := &config.Config{
		Version: 1,
		Connections: map[string]config.Connection{
			"main": {Driver: "mysql", Host: "", Port: 3306, Database: "app", Username: "root"},
		},
	}
	if err := cfg.Validate(); err == nil {
		t.Error("expected error for missing host, got nil")
	}
}

func TestValidate_InvalidPort(t *testing.T) {
	cases := []int{0, -1, 65536, 99999}
	for _, port := range cases {
		cfg := &config.Config{
			Version: 1,
			Connections: map[string]config.Connection{
				"main": {Driver: "mysql", Host: "localhost", Port: port, Database: "app", Username: "root"},
			},
		}
		if err := cfg.Validate(); err == nil {
			t.Errorf("expected error for port %d, got nil", port)
		}
	}
}

func TestValidate_MissingDatabase(t *testing.T) {
	cfg := &config.Config{
		Version: 1,
		Connections: map[string]config.Connection{
			"main": {Driver: "mysql", Host: "localhost", Port: 3306, Database: "", Username: "root"},
		},
	}
	if err := cfg.Validate(); err == nil {
		t.Error("expected error for missing database, got nil")
	}
}

func TestValidate_MissingUsername(t *testing.T) {
	cfg := &config.Config{
		Version: 1,
		Connections: map[string]config.Connection{
			"main": {Driver: "mysql", Host: "localhost", Port: 3306, Database: "app", Username: ""},
		},
	}
	if err := cfg.Validate(); err == nil {
		t.Error("expected error for missing username, got nil")
	}
}

func TestValidate_InvalidActiveConnection(t *testing.T) {
	cfg := &config.Config{
		Version:          1,
		Connections:      map[string]config.Connection{},
		ActiveConnection: "nonexistent",
	}
	if err := cfg.Validate(); err == nil {
		t.Error("expected error for active_connection pointing to nonexistent entry, got nil")
	}
}

func TestValidate_Valid(t *testing.T) {
	cfg := &config.Config{
		Version: 1,
		Connections: map[string]config.Connection{
			"main": {Driver: "mysql", Host: "localhost", Port: 3306, Database: "app", Username: "root"},
		},
		ActiveConnection: "main",
	}
	if err := cfg.Validate(); err != nil {
		t.Errorf("expected no error for valid config, got: %v", err)
	}
}

func TestSaveLoad_Roundtrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")

	original := &config.Config{
		Version: 1,
		Connections: map[string]config.Connection{
			"prod": {
				Driver:   "mysql",
				Host:     "db.example.com",
				Port:     3306,
				Database: "myapp",
				Username: "heydb_reader",
				Password: "secret123",
				TLS:      true,
				Timeout:  30,
			},
		},
		ActiveConnection: "prod",
	}

	if err := config.Save(path, original); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	loaded, err := config.Load(path)
	if err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	conn := loaded.Connections["prod"]
	if conn.Driver != "mysql" {
		t.Errorf("Driver: got %q want %q", conn.Driver, "mysql")
	}
	if conn.Host != "db.example.com" {
		t.Errorf("Host: got %q want %q", conn.Host, "db.example.com")
	}
	if conn.Port != 3306 {
		t.Errorf("Port: got %d want %d", conn.Port, 3306)
	}
	if conn.Database != "myapp" {
		t.Errorf("Database: got %q want %q", conn.Database, "myapp")
	}
	if conn.Username != "heydb_reader" {
		t.Errorf("Username: got %q want %q", conn.Username, "heydb_reader")
	}
	if conn.Password != "secret123" {
		t.Errorf("Password: got %q want %q", conn.Password, "secret123")
	}
	if conn.TLS != true {
		t.Error("TLS: got false want true")
	}
	if conn.Timeout != 30 {
		t.Errorf("Timeout: got %d want %d", conn.Timeout, 30)
	}
	if loaded.ActiveConnection != "prod" {
		t.Errorf("ActiveConnection: got %q want %q", loaded.ActiveConnection, "prod")
	}
}

func TestLoad_NonExistentReturnsDefault(t *testing.T) {
	cfg, err := config.Load("/tmp/heydb_does_not_exist_xyz.json")
	if err != nil {
		t.Fatalf("Load of missing file should return default, got error: %v", err)
	}
	if cfg == nil {
		t.Fatal("expected non-nil default config")
	}
	if cfg.Connections == nil {
		t.Error("default config Connections should be non-nil map")
	}
}

func TestSave_CreatesParentDir(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "subdir", "config.json")

	cfg := &config.Config{Version: 1, Connections: map[string]config.Connection{}}
	if err := config.Save(path, cfg); err != nil {
		t.Fatalf("Save should create parent directories: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("file should exist after Save: %v", err)
	}
}
