package cli

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
	"github.com/spf13/cobra/doc"
)

var docCmd = &cobra.Command{
	Use:   "doc",
	Short: "Generate Markdown documentation for bridgectl",
	Long: `Generate a comprehensive set of Markdown files documenting all 
available commands, flags, and usage examples for bridgectl. 
The files are saved to the docs/cli directory by default.`,
	Example: `  bridgectl doc`,
	RunE: func(_ *cobra.Command, _ []string) error {
		dir := "docs/cli"
		if err := os.MkdirAll(dir, 0750); err != nil {
			return fmt.Errorf("failed to create docs directory: %w", err)
		}

		err := doc.GenMarkdownTree(RootCmd, dir)
		if err != nil {
			return fmt.Errorf("failed to generate documentation: %w", err)
		}

		fmt.Printf("✓ Documentation generated in %s/\n", dir)
		return nil
	},
}

func init() {
	RootCmd.AddCommand(docCmd)
}
