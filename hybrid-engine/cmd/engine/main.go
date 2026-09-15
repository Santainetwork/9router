package main

import (
	"context"
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
	"github.com/santainetwork/9router-hybrid/pkg/proxy"
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

type BucketDetailReq struct {
	Scope string `json:"scope"`
	Key   string `json:"key"`
}

func defaultStaticDir() string {
	candidates := []string{
		"/opt/9router/deploy",
		"./deploy",
		"../../deploy",
	}
	for _, dir := range candidates {
		if fi, err := os.Stat(dir); err == nil && fi.IsDir() {
			return dir
		}
	}
	return "./deploy"
}

func main() {
	port := flag.Int("port", 20129, "HTTP port for hybrid engine")
	proxyPort := flag.Int("proxy-port", 0, "HTTP port for front-door reverse proxy (0 = disabled, e.g. 20140)")
	upstream := flag.String("upstream", "http://127.0.0.1:20128", "Upstream server URL to proxy allowed requests to")
	staticDir := flag.String("static-dir", defaultStaticDir(), "Directory containing static html assets (usage-check.html, docs.html)")
	proxyConcurrency := flag.Int("proxy-concurrency", 0, "Default per-key concurrency limit in proxy (0 = dynamic from limiter or disabled)")
	proxyRPM := flag.Int("proxy-rpm", 0, "Default per-key RPM limit in proxy (0 = disabled)")
	proxyTimeout := flag.Int("proxy-timeout", 60, "Proxy queue timeout in seconds")
	flag.Parse()

	eng := limiter.NewEngine()
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"status":  "ok",
			"engine":  "go-hybrid-v1",
			"buckets": eng.BucketCount(),
		})
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

	mux.HandleFunc("/v1/limiter/bucket-detail", func(w http.ResponseWriter, r *http.Request) {
		scope := r.URL.Query().Get("scope")
		key := r.URL.Query().Get("key")
		if scope == "" || key == "" {
			http.Error(w, "scope and key query params required", http.StatusBadRequest)
			return
		}
		detail := eng.GetBucketDetail(scope, key)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(detail)
	})

	limiterAddr := fmt.Sprintf("127.0.0.1:%d", *port)
	limiterSrv := &http.Server{
		Addr:         limiterAddr,
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 65 * time.Second, // Allow waiters up to 60s
	}

	go func() {
		if err := limiterSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("[Hybrid Go Engine] Limiter server error: %v", err)
		}
	}()
	log.Printf("[Hybrid Go Engine] Listening on http://%s\n", limiterAddr)

	var proxySrv *http.Server
	if *proxyPort > 0 {
		proxyHandler, err := proxy.NewServer(proxy.Config{
			UpstreamURL:    *upstream,
			StaticDir:      *staticDir,
			Limiter:        eng,
			KeyConcurrency: *proxyConcurrency,
			KeyRPM:         *proxyRPM,
			QueueTimeout:   time.Duration(*proxyTimeout) * time.Second,
		})
		if err != nil {
			log.Fatalf("[Frontdoor Proxy] Initialization error: %v", err)
		}

		proxyAddr := fmt.Sprintf(":%d", *proxyPort)
		proxySrv = &http.Server{
			Addr:              proxyAddr,
			Handler:           proxyHandler,
			ReadHeaderTimeout: 10 * time.Second,
			IdleTimeout:       120 * time.Second,
			// WriteTimeout is intentionally omitted (0) to allow long-lived SSE streams
		}

		go func() {
			if err := proxySrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Fatalf("[Frontdoor Proxy] Server error: %v", err)
			}
		}()
		log.Printf("[Frontdoor Proxy] Listening on http://%s -> Upstream %s (static: %s)\n", proxyAddr, *upstream, *staticDir)
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	log.Println("[Hybrid Go Engine] Shutting down...")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if proxySrv != nil {
		if err := proxySrv.Shutdown(shutdownCtx); err != nil {
			log.Printf("[Frontdoor Proxy] Shutdown error: %v", err)
		}
	}
	if err := limiterSrv.Shutdown(shutdownCtx); err != nil {
		log.Printf("[Hybrid Go Engine] Limiter shutdown error: %v", err)
	}
	eng.Stop()
	log.Println("[Hybrid Go Engine] Shutdown complete.")
}
