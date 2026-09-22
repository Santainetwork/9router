package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/santainetwork/9router-hybrid/pkg/limiter"
)

// AllowedPrefixes lists paths permitted through the front-door reverse proxy.
var AllowedPrefixes = []string{
	"/v1/",
	"/api/v1/",
	"/v2/",
	"/api/v2/",
	"/nosaver/",
	"/v1beta/",
	"/manifest.webmanifest",
	"/favicon.ico",
	"/favicon.svg",
}

// Config configures the front-door reverse proxy.
type Config struct {
	UpstreamURL    string
	StaticDir      string
	Limiter        *limiter.Engine
	KeyConcurrency int
	KeyRPM         int
	QueueTimeout   time.Duration
	Scope          string
	AllowAllPaths  bool // When true (gateway mode), forwards all paths (e.g. /dashboard, /_next, /api)
	APIWorkerURLs  []string
}

type apiWorker struct {
	url     *url.URL
	healthy atomic.Bool
}

// Server is the HTTP front-door reverse proxy server.
type Server struct {
	cfg          Config
	upstreamURL  *url.URL
	reverseProxy *httputil.ReverseProxy
	apiWorkers   []*apiWorker
	nextWorker   atomic.Uint64
	stopHealth   chan struct{}
	closeOnce    sync.Once
}

func (s *Server) proxyGatingEnabled() bool {
	return !s.cfg.AllowAllPaths || s.cfg.KeyConcurrency > 0 || s.cfg.KeyRPM > 0
}

// IsAllowedPath returns true if the given path matches the allowed public prefixes.
func IsAllowedPath(p string) bool {
	for _, prefix := range AllowedPrefixes {
		if p == prefix || strings.HasPrefix(p, prefix) {
			return true
		}
		if strings.HasSuffix(prefix, "/") && p == strings.TrimSuffix(prefix, "/") {
			return true
		}
	}
	return false
}

// ExtractAPIKey extracts the API key token from Authorization or x-api-key headers.
func ExtractAPIKey(r *http.Request) string {
	if auth := r.Header.Get("Authorization"); auth != "" {
		parts := strings.SplitN(auth, " ", 2)
		if len(parts) == 2 && strings.EqualFold(parts[0], "bearer") {
			if key := strings.TrimSpace(parts[1]); key != "" {
				return key
			}
		}
	}
	if key := strings.TrimSpace(r.Header.Get("x-api-key")); key != "" {
		return key
	}
	if key := strings.TrimSpace(r.Header.Get("api-key")); key != "" {
		return key
	}
	return ""
}

func isAPIRequest(path string) bool {
	return strings.HasPrefix(path, "/v1/") ||
		strings.HasPrefix(path, "/api/v1/") ||
		strings.HasPrefix(path, "/v2/") ||
		strings.HasPrefix(path, "/api/v2/") ||
		strings.HasPrefix(path, "/nosaver/") ||
		strings.HasPrefix(path, "/v1beta/")
}

func isAPIWorkerRequest(r *http.Request) bool {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		return false
	}
	path := r.URL.Path
	return strings.HasPrefix(path, "/v1/") ||
		strings.HasPrefix(path, "/api/v1/") ||
		strings.HasPrefix(path, "/v2/") ||
		strings.HasPrefix(path, "/api/v2/") ||
		strings.HasPrefix(path, "/nosaver/") ||
		strings.HasPrefix(path, "/v1beta/")
}

// parseWorkerURL validates an internal API worker URL. Worker URLs must be
// loopback HTTP(S) origins: no path, query, fragment, or userinfo, and an
// explicit nonzero port. A missing scheme defaults to http.
func parseWorkerURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errors.New("empty API worker URL")
	}

	// Detect an explicit scheme without url.Parse so malformed inputs like
	// "ftp://host" are rejected instead of being prefixed into "http://ftp://host".
	if i := strings.Index(raw, "://"); i >= 0 {
		switch scheme := raw[:i]; scheme {
		case "http", "https":
		default:
			return nil, fmt.Errorf("unsupported API worker scheme %q", scheme)
		}
	} else {
		raw = "http://" + raw
	}

	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid API worker URL %q: %w", raw, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("unsupported API worker scheme %q", u.Scheme)
	}
	if u.Opaque != "" || u.Host == "" {
		return nil, fmt.Errorf("invalid API worker URL %q: missing host", raw)
	}
	if u.User != nil {
		return nil, fmt.Errorf("API worker URL %q must not contain userinfo", raw)
	}
	port := u.Port()
	if port == "" {
		return nil, fmt.Errorf("API worker URL %q must specify an explicit port", raw)
	}
	if n, err := strconv.Atoi(port); err != nil || n <= 0 || n > 65535 {
		return nil, fmt.Errorf("invalid API worker port %q", port)
	}
	if u.Path != "" && u.Path != "/" {
		return nil, fmt.Errorf("API worker URL %q must not contain a path", raw)
	}
	if u.RawQuery != "" {
		return nil, fmt.Errorf("API worker URL %q must not contain a query", raw)
	}
	if u.Fragment != "" {
		return nil, fmt.Errorf("API worker URL %q must not contain a fragment", raw)
	}

	host := u.Hostname()
	if host != "localhost" {
		if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
			return nil, fmt.Errorf("API worker URL %q must use a loopback host", raw)
		}
	}

	// Normalize away any retained path/query/fragment.
	u.Path = ""
	u.RawPath = ""
	u.RawQuery = ""
	u.Fragment = ""
	return u, nil
}

// NewServer initializes a new front-door reverse proxy server.
func NewServer(cfg Config) (*Server, error) {
	if cfg.UpstreamURL == "" {
		cfg.UpstreamURL = "http://127.0.0.1:20128"
	}
	rawURL := cfg.UpstreamURL
	if !strings.HasPrefix(rawURL, "http://") && !strings.HasPrefix(rawURL, "https://") {
		rawURL = "http://" + rawURL
	}
	target, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("invalid upstream URL: %w", err)
	}

	if cfg.Scope == "" {
		cfg.Scope = "apikey"
	}
	if cfg.QueueTimeout <= 0 {
		cfg.QueueTimeout = 60 * time.Second
	}

	workers := make([]*apiWorker, 0, len(cfg.APIWorkerURLs))
	for _, rawWorkerURL := range cfg.APIWorkerURLs {
		if strings.TrimSpace(rawWorkerURL) == "" {
			continue
		}
		workerURL, err := parseWorkerURL(rawWorkerURL)
		if err != nil {
			return nil, err
		}
		workers = append(workers, &apiWorker{url: workerURL})
	}

	rp := httputil.NewSingleHostReverseProxy(target)
	rp.FlushInterval = -1 // Stream SSE chunks immediately without buffering

	rp.Transport = &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   30 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     false,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   50,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		ResponseHeaderTimeout: 300 * time.Second, // Long-lived streaming/reasoning models
	}

	s := &Server{
		cfg:          cfg,
		upstreamURL:  target,
		reverseProxy: rp,
		apiWorkers:   workers,
		stopHealth:   make(chan struct{}),
	}
	originalDirector := rp.Director
	rp.Director = func(req *http.Request) {
		originalDirector(req)
		if worker := s.nextHealthyWorker(req); worker != nil {
			req.URL.Scheme = worker.url.Scheme
			req.URL.Host = worker.url.Host
		}
		if req.Header.Get("X-Forwarded-Host") == "" && req.Host != "" {
			req.Header.Set("X-Forwarded-Host", req.Host)
		}
		if req.Header.Get("X-Forwarded-Proto") == "" {
			if req.TLS != nil {
				req.Header.Set("X-Forwarded-Proto", "https")
			} else {
				req.Header.Set("X-Forwarded-Proto", "http")
			}
		}
		if clientIP, _, err := net.SplitHostPort(req.RemoteAddr); err == nil && clientIP != "" {
			if req.Header.Get("X-Real-IP") == "" {
				req.Header.Set("X-Real-IP", clientIP)
			}
			if prior := req.Header.Get("X-Forwarded-For"); prior == "" {
				req.Header.Set("X-Forwarded-For", clientIP)
			}
		}
	}

	rp.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		if errors.Is(err, context.Canceled) {
			return
		}
		log.Printf("[frontdoor-proxy] Upstream error: %v", err)
		http.Error(w, "Bad Gateway", http.StatusBadGateway)
	}

	if len(workers) > 0 {
		s.checkAPIWorkers()
		go s.monitorAPIWorkers()
	}
	return s, nil
}

func (s *Server) nextHealthyWorker(r *http.Request) *apiWorker {
	if !isAPIWorkerRequest(r) || len(s.apiWorkers) == 0 {
		return nil
	}
	start := s.nextWorker.Add(1) - 1
	healthy := make([]*apiWorker, 0, len(s.apiWorkers))
	for _, worker := range s.apiWorkers {
		if worker.healthy.Load() {
			healthy = append(healthy, worker)
		}
	}
	if len(healthy) == 0 {
		return nil
	}
	return healthy[int(start%uint64(len(healthy)))]
}

func (s *Server) checkAPIWorkers() {
	client := &http.Client{Timeout: 2 * time.Second}
	for _, worker := range s.apiWorkers {
		resp, err := client.Get(workerHealthURL(worker.url))
		healthy := err == nil && resp.StatusCode >= http.StatusOK && resp.StatusCode < http.StatusMultipleChoices
		if resp != nil {
			_ = resp.Body.Close()
		}
		worker.healthy.Store(healthy)
	}
}

// workerHealthURL builds the readiness probe URL from a validated worker origin,
// always resolving the path to /api/ready.
func workerHealthURL(u *url.URL) string {
	health := *u
	health.Path = "/api/ready"
	health.RawPath = ""
	health.RawQuery = ""
	health.Fragment = ""
	return health.String()
}

func (s *Server) monitorAPIWorkers() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			s.checkAPIWorkers()
		case <-s.stopHealth:
			return
		}
	}
}

// Close stops API worker health checks.
func (s *Server) Close() {
	s.closeOnce.Do(func() { close(s.stopHealth) })
}

func (s *Server) serveStatic(w http.ResponseWriter, filename string) bool {
	path := filepath.Join(s.cfg.StaticDir, filename)
	content, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(content)
	return true
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	reqPath := r.URL.Path
	if reqPath == "" {
		reqPath = "/"
	}

	// Readiness is internal-only. Both the master gateway and the public proxy
	// deny it up front, before any static serving, gating, or upstream forward.
	if reqPath == "/api/ready" || strings.HasPrefix(reqPath, "/api/ready/") {
		http.Error(w, "404 Not Found", http.StatusNotFound)
		return
	}

	// 1. Serve self-contained usage-check page locally
	if reqPath == "/usage-check" || reqPath == "/usage-check/" {
		if s.serveStatic(w, "usage-check.html") {
			return
		}
	}

	// 2. In public proxy mode (AllowAllPaths = false), serve docs or 404
	if !s.cfg.AllowAllPaths {
		if reqPath == "/docs" || reqPath == "/docs/" || reqPath == "/" {
			if s.serveStatic(w, "docs.html") {
				return
			}
			http.Error(w, "404 Not Found", http.StatusNotFound)
			return
		}

		if !IsAllowedPath(reqPath) {
			http.Error(w, "404 Not Found", http.StatusNotFound)
			return
		}
	}

	// 3. Front-door concurrency & rate limiting gating for API endpoints
	if isAPIRequest(reqPath) && s.cfg.Limiter != nil && s.proxyGatingEnabled() {
		apiKey := ExtractAPIKey(r)
		if apiKey != "" {
			concurrency := s.cfg.KeyConcurrency
			rpm := s.cfg.KeyRPM

			if concurrency <= 0 && rpm <= 0 {
				detail := s.cfg.Limiter.GetBucketDetail(s.cfg.Scope, apiKey)
				concurrency = detail.Concurrency
				rpm = detail.RPM
			}

			if concurrency > 0 || rpm > 0 {
				timeout := s.cfg.QueueTimeout
				if timeout <= 0 {
					timeout = 60 * time.Second
				}

				leaseID, err := s.cfg.Limiter.AcquireLease(r.Context(), s.cfg.Scope, apiKey, rpm, concurrency, timeout)
				if err != nil {
					if errors.Is(err, context.Canceled) {
						return
					}
					w.Header().Set("Content-Type", "application/json")
					w.Header().Set("Retry-After", "1")
					w.WriteHeader(http.StatusTooManyRequests)
					_ = json.NewEncoder(w).Encode(map[string]any{
						"error": map[string]any{
							"message": err.Error(),
							"type":    "rate_limit_error",
							"code":    http.StatusTooManyRequests,
						},
					})
					return
				}

				// RPM-only grants own no concurrency slot (leaseID == ""), so
				// they must not call Release. Concurrency grants release their
				// exact lease to avoid stealing a slot re-acquired after
				// watchdog expiry.
				if leaseID != "" {
					defer s.cfg.Limiter.Release(s.cfg.Scope, apiKey, leaseID)
				}
			}
		}
	}

	// 4. Forward request to upstream Next.js
	s.reverseProxy.ServeHTTP(w, r)
}
