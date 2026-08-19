package cli

import (
	"github.com/nimendra/ERPBridge/internal/banner"
	"github.com/spf13/cobra"
)

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print the version number of bridgectl",
	Long:  `All software has versions. This is bridgectl's.`,
	Run: func(cmd *cobra.Command, _ []string) {
		banner.Print(cmd.OutOrStdout(), "bridgectl", RootCmd.Version)
	},
}

func init() {
	RootCmd.AddCommand(versionCmd)
}
