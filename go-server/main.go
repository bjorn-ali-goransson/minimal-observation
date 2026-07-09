// Command moserver is a Go port of @mo/server (ingest + query API + static UI over
// tiered DuckDB storage), built to compare runtime memory footprint against the
// Node/TypeScript original. Same env contract, same DuckDB config, same React UI.
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
)

func main() {
	cfg := loadConfig()
	store, err := newStore(cfg)
	if err != nil {
		log.Fatalf("store init: %v", err)
	}
	srv := &Server{cfg: cfg, store: store}
	addr := fmt.Sprintf(":%d", cfg.Port)
	fmt.Fprintf(os.Stderr, "minimal-observation (go) listening on %s (cold=%s, retention=%dd)\n", addr, cfg.ColdKind, cfg.RetentionDays)
	if err := http.ListenAndServe(addr, srv.routes()); err != nil {
		log.Fatal(err)
	}
}
