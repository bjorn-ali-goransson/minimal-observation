package main

import (
	"os"
	"path/filepath"
	"strconv"
)

// Config mirrors the TypeScript server's env contract so the two are directly comparable.
type Config struct {
	APIKey        string
	Port          int
	DataDir       string
	RetentionDays int
	FlushMaxRows  int
	FlushMaxMs    int
	ColdKind      string // frozen tier backend: "local" (dir) or "s3" (MinIO / real S3)
	ColdIdleMs    int
	S3            S3Config
	UIDir         string
	AgentEnabled  bool
	AgentAPIKey   string
	AgentModel    string
	AgentBaseURL  string // override the Anthropic API base URL (e.g. a local mock)
}

type S3Config struct {
	Endpoint  string
	Region    string
	Bucket    string
	AccessKey string
	SecretKey string
	URLStyle  string
}

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func envi(k string, d int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return d
}

func loadConfig() Config {
	dataDir, _ := filepath.Abs(env("MO_DATA_DIR", "./data"))
	return Config{
		APIKey:        env("MO_API_KEY", "dev-secret-key"),
		Port:          envi("MO_PORT", 4318),
		DataDir:       dataDir,
		RetentionDays: envi("MO_RETENTION_DAYS", 7),
		FlushMaxRows:  envi("MO_FLUSH_MAX_ROWS", 2000),
		FlushMaxMs:    envi("MO_FLUSH_MAX_MS", 2000),
		ColdKind:      env("MO_COLD_KIND", "local"),
		ColdIdleMs:    envi("MO_COLD_IDLE_MS", 3600000),
		S3: S3Config{
			Endpoint:  env("MO_S3_ENDPOINT", "http://minio:9000"),
			Region:    env("MO_S3_REGION", "us-east-1"),
			Bucket:    env("MO_S3_BUCKET", "mo-spans"),
			AccessKey: env("MO_S3_ACCESS_KEY", "minioadmin"),
			SecretKey: env("MO_S3_SECRET_KEY", "minioadmin"),
			URLStyle:  env("MO_S3_URL_STYLE", "path"),
		},
		UIDir:        env("MO_UI_DIR", ""),
		AgentEnabled: os.Getenv("ANTHROPIC_API_KEY") != "",
		AgentAPIKey:  os.Getenv("ANTHROPIC_API_KEY"),
		AgentModel:   env("MO_AGENT_MODEL", "claude-opus-4-8"),
		AgentBaseURL: env("ANTHROPIC_BASE_URL", env("MO_AGENT_BASE_URL", "https://api.anthropic.com")),
	}
}
