// Package main is the entry point for the ERPBridge server.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	mcp_server "github.com/mark3labs/mcp-go/server"
	"github.com/nimendra/ERPBridge/internal/banner"
	"github.com/nimendra/ERPBridge/internal/cache"
	"github.com/nimendra/ERPBridge/internal/connector"
	"github.com/nimendra/ERPBridge/internal/logger"
	"github.com/nimendra/ERPBridge/internal/mcp"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"
)

var version = "dev"

func main() {
	// Print startup banner
	banner.Print(os.Stdout, "ERPBridge Server", version)

	stdioFlag := flag.Bool("stdio", false, "Run in STDIO transport mode")
	flag.Parse()

	transport := os.Getenv("MCP_TRANSPORT")
	useStdio := *stdioFlag || transport == "stdio"

	if useStdio {
		_ = os.Setenv("LOG_TO_STDERR", "true")
	}

	// Initialize Logger
	rootLog := logger.Init()

	slog.Info("Starting ERPBridge Server", slog.String("version", version), slog.Bool("stdio", useStdio))

	mcpPort := os.Getenv("MCP_PORT")
	if mcpPort == "" {
		mcpPort = "8080"
	}

	dbPath := os.Getenv("DATABASE_PATH")
	if dbPath == "" {
		dbPath = "data/erpbridge.db"
	}

	redisURL := os.Getenv("REDIS_URL")

	rateRPS := 5.0
	if v := os.Getenv("RATE_LIMIT_RPS"); v != "" {
		if _, err := fmt.Sscanf(v, "%f", &rateRPS); err != nil {
			slog.Warn("failed to parse RATE_LIMIT_RPS", slog.String("value", v), slog.String("error", err.Error()))
		}
	}
	rateBurst := 10
	if v := os.Getenv("RATE_LIMIT_BURST"); v != "" {
		if _, err := fmt.Sscanf(v, "%d", &rateBurst); err != nil {
			slog.Warn("failed to parse RATE_LIMIT_BURST", slog.String("value", v), slog.String("error", err.Error()))
		}
	}

	// In a real scenario, this should be the public URL of the server
	baseURL := os.Getenv("BASE_URL")
	if baseURL == "" {
		baseURL = fmt.Sprintf("http://localhost:%s", mcpPort)
	}

	// Initialize Cache
	var cacheMgr *cache.Manager
	if redisURL != "" {
		opt, err := redis.ParseURL(redisURL)
		if err != nil {
			slog.Error("failed to parse redis url", slog.String("error", err.Error()))
		} else {
			rdb := redis.NewClient(opt)
			cacheMgr = cache.NewManager(rdb, rootLog)
			if err := cacheMgr.EnsureIndex(context.Background()); err != nil {
				slog.Warn("failed to ensure redis index", slog.String("error", err.Error()))
			}
			slog.Info("cache initialized", slog.String("redis_url", redisURL))
		}
	}

	conn := connector.NewClient(rootLog)
	server := mcp.NewServer(conn, cacheMgr, rootLog, mcp.RateLimitConfig{
		RequestsPerSecond: rateRPS,
		Burst:             rateBurst,
	}, dbPath)

	// Setup signal-aware context for background workers
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Start Reconciliation Loop
	go server.StartController(ctx)

	// Trigger Server Start Hook
	server.TelemetryHooks.OnServerStart()
	defer server.TelemetryHooks.OnServerStop()

	if useStdio {
		slog.Info("ERPBridge Server running in STDIO mode")
		if err := mcp_server.ServeStdio(server.MCPServer()); err != nil {
			slog.Error("stdio server failed", slog.String("error", err.Error()))
		}
		return
	}

	mux := http.NewServeMux()
	server.ServeHTTP(mux, baseURL)

	// Metrics endpoint
	mux.Handle("/metrics", promhttp.Handler())

	slog.Info("ERPBridge Server listening",
		slog.String("port", mcpPort),
		slog.String("mcp_http", baseURL+"/mcp/"),
	)
	httpServer := &http.Server{
		Addr:              ":" + mcpPort,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("server stopped with error", slog.String("error", err.Error()))
	}
}
