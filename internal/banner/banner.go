// Package banner provides ASCII logo and version banner printing for ERPBridge.
package banner

import (
	"fmt"
	"io"
)

// Logo contains the ASCII art logo for ERPBridge.
const Logo = `
 _____ ____  ____  ____       _     _            
| ____|  _ \|  _ \| __ ) _ __(_)___| | __ _  ___ 
|  _| | |_) | |_) |  _ \| '__| / __| |/ _` + "`" + ` |/ _ \
| |___|  _ <|  __/| |_) | |  | \__ \ | (_| |  __/
|_____|_| \_\_|   |____/|_|  |_|___/_|\__, |\___|
                                      |___/      
`

// Print prints the ERPBridge banner along with version information.
func Print(w io.Writer, component, version string) {
	_, _ = fmt.Fprint(w, Logo)
	_, _ = fmt.Fprintf(w, "%s: A declarative MCP Control Plane for Legacy ERPs.\n", component)
	_, _ = fmt.Fprintf(w, "Version: %s\n\n", version)
}
