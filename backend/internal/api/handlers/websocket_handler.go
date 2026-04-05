package handlers

import (
	"time"

	"github.com/gofiber/contrib/websocket"
)

func (h *Handler) WebSocketEvents(conn *websocket.Conn) {
	defer conn.Close()
	channel := conn.Params("*")
	if channel == "" {
		channel = "system-health"
	}

	event := map[string]interface{}{
		"type":      "system.health.changed",
		"id":        "evt_" + randomHex(4),
		"timestamp": time.Now().UTC(),
		"data": map[string]interface{}{
			"channel": channel,
			"overall": "healthy",
			"service": map[string]interface{}{"name": "Agentic Orchestrator", "status": "healthy", "value": 96, "meta": "local websocket ready"},
		},
	}
	_ = conn.WriteJSON(event)
}
