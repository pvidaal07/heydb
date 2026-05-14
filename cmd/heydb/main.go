package main

import (
	"github.com/pvidaal07/heydb/internal/cli"
)

// version is set at build time via ldflags:
//
//	go build -ldflags "-X main.version=v1.2.3" ./cmd/heydb
var version = "dev"

func main() {
	cli.SetVersion(version)
	cli.Execute()
}
