package mcp

import (
	"context"

	"github.com/mark3labs/mcp-go/server"
)

// CustomNotifier handles sending structured notifications to MCP clients.
type CustomNotifier struct {
	mcpServer *server.MCPServer
}

// NewCustomNotifier creates a new CustomNotifier instance.
func NewCustomNotifier(s *server.MCPServer) *CustomNotifier {
	return &CustomNotifier{mcpServer: s}
}

const (
	notifFieldMessage = "message"
	notifFieldName    = "name"
)

// SendProgress sends a progress notification to the client associated with the context.
func (n *CustomNotifier) SendProgress(ctx context.Context, progress int, total int, message string) {
	_ = n.mcpServer.SendNotificationToClient(ctx, "notifications/progress", map[string]any{
		"progress":        progress,
		"total":           total,
		notifFieldMessage: message,
	})
}

// SendAlert sends an alert notification to the client associated with the context.
func (n *CustomNotifier) SendAlert(ctx context.Context, message string, severity string) {
	_ = n.mcpServer.SendNotificationToClient(ctx, "notifications/alert", map[string]any{
		notifFieldMessage: message,
		"severity":        severity,
	})
}

// BroadcastSystemMessage sends a system-wide message to all connected clients.
func (n *CustomNotifier) BroadcastSystemMessage(message string) {
	n.mcpServer.SendNotificationToAllClients("notifications/message", map[string]any{
		notifFieldMessage: message,
		"type":            "system",
	})
}

// SendToolDeleted notifies all clients that a specific tool has been deleted.
func (n *CustomNotifier) SendToolDeleted(name, version string) {
	n.mcpServer.SendNotificationToAllClients("notifications/tool_deleted", map[string]any{
		notifFieldName: name,
		"version":      version,
		"reason":       "tool deregistered from registry",
	})
}
