package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/santainetwork/9router-hybrid/pkg/limiter"
)

type AcquireReq struct {
	Scope       string `json:"scope"`
	Key         string `json:"key"`
	RPM         int    `json:"rpm"`
	Concurrency int    `json:"concurrency"`
	TimeoutMs   int    `json:"timeoutMs"`
}

type ReleaseReq struct {
	Scope string `json:"scope"`
	Key   string `json:"key"`
}

type ResetReq struct {
	Scope string `json:"scope"`
	Key   string `json:"key"`
	All   bool   `json:"all"`
}

func main() {
	port := flag.Int("port", 20129, "HTTP port for hybrid engine")
	flag.Parse()

	eng := limiter.NewEngine()
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"status": "ok", "engine": "go-hybrid-v1"})
	})

	mux.HandleFunc("/v1/limiter/acquire", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req AcquireReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		timeout := time.Duration(req.TimeoutMs) * time.Millisecond
		err := eng.Acquire(r.Context(), req.Scope, req.Key, req.RPM, req.Concurrency, timeout)

		w.Header().Set("Content-Type", "application/json")
		if err != nil {
			status := http.StatusTooManyRequests
			w.WriteHeader(status)
			json.NewEncoder(w).Encode(map[string]any{
				"allowed": false,
				"error":   err.Error(),
			})
			return
		}

		json.NewEncoder(w).Encode(map[string]any{
			"allowed": true,
		})
	})

	mux.HandleFunc("/v1/limiter/release", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req ReleaseReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		eng.Release(req.Scope, req.Key)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"released": true})
	})

	mux.HandleFunc("/v1/limiter/reset", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req ResetReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		var cleared int
		if req.All {
			cleared = eng.ResetAll()
		} else {
			cleared = eng.Reset(req.Scope, req.Key)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"cleared": cleared})
	})

	mux.HandleFunc("/v1/limiter/snapshot", func(w http.ResponseWriter, r *http.Request) {
		snap := eng.Snapshot()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(snap)
	})

	addr := fmt.Sprintf("127.0.0.1:%d", *port)
	srv := &http.Server{
		Addr:         addr,
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 65 * time.Second, // Allow waiters up to 60s
	}

	log.Printf("[Hybrid Go Engine] Listening on http://%s\n", addr)

	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Listen error: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	log.Println("[Hybrid Go Engine] Shutting down...")
}
