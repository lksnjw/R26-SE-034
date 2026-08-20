// Package main is the entry point for the bridgectl CLI.
package main

import (
	"github.com/nimendra/ERPBridge/internal/cli"
)

var version = "dev"

func main() {
	cli.RootCmd.Version = version
	cli.Execute()
}
