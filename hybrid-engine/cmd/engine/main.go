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
	"strings"
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

func newPublicServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       5 * time.Minute,
		IdleTimeout:       120 * time.Second,
	}
}

func readyHandler(upstream string) http.HandlerFunc {
	client := &http.Client{Timeout: 2 * time.Second}
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		probeURL := strings.TrimRight(upstream, "/") + "/api/health"
		resp, err := client.Get(probeURL)
		if err != nil {
			http.Error(w, "upstream not ready", http.StatusServiceUnavailable)
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
			http.Error(w, "upstream not ready", http.StatusServiceUnavailable)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ready":true}`))
	}
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
	gatewayPort := flag.Int("gateway-port", 0, "HTTP port for master gateway (0 = disabled, e.g. 20128, allows all paths and gates /v1)")
	proxyPort := flag.Int("proxy-port", 0, "HTTP port for public-only reverse proxy (0 = disabled, e.g. 20140, 404s on admin)")
	upstream := flag.String("upstream", "http://127.0.0.1:20128", "Upstream Next.js server URL to proxy to")
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
	mux.Handle("/ready", readyHandler(*upstream))

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

	var gatewaySrv *http.Server
	if *gatewayPort > 0 {
		gatewayHandler, err := proxy.NewServer(proxy.Config{
			UpstreamURL:    *upstream,
			StaticDir:      *staticDir,
			Limiter:        eng,
			KeyConcurrency: *proxyConcurrency,
			KeyRPM:         *proxyRPM,
			QueueTimeout:   time.Duration(*proxyTimeout) * time.Second,
			AllowAllPaths:  true, // Master Gateway allows /dashboard, /_next, /api, and gates /v1
		})
		if err != nil {
			log.Fatalf("[Master Gateway] Initialization error: %v", err)
		}

		gatewayAddr := fmt.Sprintf(":%d", *gatewayPort)
		gatewaySrv = newPublicServer(gatewayAddr, gatewayHandler)

		go func() {
			if err := gatewaySrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				log.Fatalf("[Master Gateway] Server error: %v", err)
			}
		}()
		log.Printf("[Master Gateway] Listening on http://%s -> Upstream %s (All routes, Go concurrency gate on /v1)\n", gatewayAddr, *upstream)
	}

	var proxySrv *http.Server
	if *proxyPort > 0 {
		proxyHandler, err := proxy.NewServer(proxy.Config{
			UpstreamURL:    *upstream,
			StaticDir:      *staticDir,
			Limiter:        eng,
			KeyConcurrency: *proxyConcurrency,
			KeyRPM:         *proxyRPM,
			QueueTimeout:   time.Duration(*proxyTimeout) * time.Second,
			AllowAllPaths:  false, // Public proxy mode: blocks admin routes with 404
		})
		if err != nil {
			log.Fatalf("[Frontdoor Proxy] Initialization error: %v", err)
		}

		proxyAddr := fmt.Sprintf(":%d", *proxyPort)
		proxySrv = newPublicServer(proxyAddr, proxyHandler)

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

	if gatewaySrv != nil {
		if err := gatewaySrv.Shutdown(shutdownCtx); err != nil {
			log.Printf("[Master Gateway] Shutdown error: %v", err)
		}
	}
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
