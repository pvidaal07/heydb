package cli

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/pvidaal07/heydb/internal/config"
)

// schemaPaths holds resolved file paths for a connection's schema files.
type schemaPaths struct {
	Dir        string // .heydb directory
	ConfigPath string // .heydb/config.json
	Markdown   string // .heydb/{connection}.md
	SQLite     string // .heydb/{connection}.sqlite
	ConnName   string // active connection name
}

// resolveActivePaths loads the config, gets the active connection name, and
// builds the file paths for that connection's schema files.
func resolveActivePaths() (*schemaPaths, *config.Config, config.Connection, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return nil, nil, config.Connection{}, fmt.Errorf("cannot determine working directory: %w", err)
	}

	dir := filepath.Join(cwd, heydbDir)
	cfgPath := filepath.Join(dir, configFileName)

	cfg, err := config.Load(cfgPath)
	if err != nil {
		return nil, nil, config.Connection{}, fmt.Errorf("load config: %w", err)
	}

	name, conn, err := cfg.Active()
	if err != nil {
		return nil, nil, config.Connection{}, fmt.Errorf("%w\n\nRun `heydb connect` to add a connection first.", err)
	}

	paths := &schemaPaths{
		Dir:        dir,
		ConfigPath: cfgPath,
		Markdown:   filepath.Join(dir, name+".md"),
		SQLite:     filepath.Join(dir, name+".sqlite"),
		ConnName:   name,
	}
	return paths, cfg, conn, nil
}

// resolvePathsForDir returns schemaPaths for a given connection name without
// loading the config. Used by commands that just need file paths.
func resolvePathsForDir(connName string) (*schemaPaths, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return nil, fmt.Errorf("cannot determine working directory: %w", err)
	}
	dir := filepath.Join(cwd, heydbDir)
	return &schemaPaths{
		Dir:        dir,
		ConfigPath: filepath.Join(dir, configFileName),
		Markdown:   filepath.Join(dir, connName+".md"),
		SQLite:     filepath.Join(dir, connName+".sqlite"),
		ConnName:   connName,
	}, nil
}
