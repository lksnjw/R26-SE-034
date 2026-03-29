package config

import "go.uber.org/zap"

type Database struct {
	URL     string
	Online  bool
	Message string
}

func NewDatabase(cfg Config, log *zap.Logger) Database {
	db := Database{
		URL:     cfg.DatabaseURL,
		Online:  false,
		Message: "in-memory repository active; PostgreSQL URL configured for production swap",
	}

	log.Info("database adapter prepared", zap.String("mode", "memory"), zap.String("url", cfg.DatabaseURL))
	return db
}
