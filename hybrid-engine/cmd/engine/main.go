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
	"strconv"
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
	Scope   string `json:"scope"`
	Key     string `json:"key"`
	LeaseID string `json:"leaseId"`
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

func limiterAcquireHandler(eng *limiter.Engine) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
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
		leaseID, err := eng.AcquireLease(r.Context(), req.Scope, req.Key, req.RPM, req.Concurrency, timeout)

		w.Header().Set("Content-Type", "application/json")
		if err != nil {
			w.WriteHeader(http.StatusTooManyRequests)
			json.NewEncoder(w).Encode(map[string]any{
				"allowed": false,
				"error":   err.Error(),
			})
			return
		}

		json.NewEncoder(w).Encode(map[string]any{
			"allowed": true,
			"leaseId": string(leaseID),
		})
	}
}

func limiterReleaseHandler(eng *limiter.Engine) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req ReleaseReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if req.LeaseID == "" {
			http.Error(w, "leaseId required", http.StatusBadRequest)
			return
		}

		eng.Release(req.Scope, req.Key, limiter.LeaseID(req.LeaseID))
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"released": true})
	}
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

		probeURL := strings.TrimRight(upstream, "/") + "/api/ready"
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

// resolveControlFallback returns the effective ControlFallback value. The
// explicit -control-fallback flag wins when set; otherwise the CONTROL_FALLBACK
// env var is honored. An invalid env value is always fatal so misconfiguration
// cannot silently disable the fail-closed default.
func resolveControlFallback(flagSet bool, flagVal bool, envRaw string) (bool, error) {
	if envRaw != "" {
		if _, err := strconv.ParseBool(envRaw); err != nil {
			return false, fmt.Errorf("invalid CONTROL_FALLBACK value %q: %w", envRaw, err)
		}
	}
	if flagSet {
		return flagVal, nil
	}
	if envRaw == "" {
		return false, nil
	}
	v, _ := strconv.ParseBool(envRaw)
	return v, nil
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
	apiWorkers := flag.String("api-workers", "", "Comma-separated API worker URLs")
	controlFallback := flag.Bool("control-fallback", false, "Allow API requests to fall back to control upstream when workers are unready and control is healthy")
	flag.Parse()

	controlFallbackSet := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == "control-fallback" {
			controlFallbackSet = true
		}
	})
	controlFallbackEnv := strings.TrimSpace(os.Getenv("CONTROL_FALLBACK"))
	controlFallbackResolved, err := resolveControlFallback(controlFallbackSet, *controlFallback, controlFallbackEnv)
	if err != nil {
		log.Fatalf("[Hybrid Go Engine] %v", err)
	}
	var apiWorkerURLs []string
	for _, workerURL := range strings.Split(*apiWorkers, ",") {
		if workerURL = strings.TrimSpace(workerURL); workerURL != "" {
			apiWorkerURLs = append(apiWorkerURLs, workerURL)
		}
	}

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

	mux.HandleFunc("/v1/limiter/acquire", limiterAcquireHandler(eng))

	mux.HandleFunc("/v1/limiter/release", limiterReleaseHandler(eng))

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
			UpstreamURL:     *upstream,
			StaticDir:       *staticDir,
			Limiter:         eng,
			KeyConcurrency:  *proxyConcurrency,
			KeyRPM:          *proxyRPM,
			QueueTimeout:    time.Duration(*proxyTimeout) * time.Second,
			AllowAllPaths:   true, // Master Gateway allows /dashboard, /_next, /api, and gates /v1
			APIWorkerURLs:   apiWorkerURLs,
			ControlFallback: controlFallbackResolved,
		})
		if err != nil {
			log.Fatalf("[Master Gateway] Initialization error: %v", err)
		}
		defer gatewayHandler.Close()

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
			UpstreamURL:     *upstream,
			StaticDir:       *staticDir,
			Limiter:         eng,
			KeyConcurrency:  *proxyConcurrency,
			KeyRPM:          *proxyRPM,
			QueueTimeout:    time.Duration(*proxyTimeout) * time.Second,
			AllowAllPaths:   false, // Public proxy mode: blocks admin routes with 404
			APIWorkerURLs:   apiWorkerURLs,
			ControlFallback: controlFallbackResolved,
		})
		if err != nil {
			log.Fatalf("[Frontdoor Proxy] Initialization error: %v", err)
		}
		defer proxyHandler.Close()

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
