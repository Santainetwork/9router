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
	"strings"
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
}

// Server is the HTTP front-door reverse proxy server.
type Server struct {
	cfg          Config
	upstreamURL  *url.URL
	reverseProxy *httputil.ReverseProxy
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

	originalDirector := rp.Director
	rp.Director = func(req *http.Request) {
		originalDirector(req)
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

	return &Server{
		cfg:          cfg,
		upstreamURL:  target,
		reverseProxy: rp,
	}, nil
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
	isAPIRequest := strings.HasPrefix(reqPath, "/v1/") ||
		strings.HasPrefix(reqPath, "/api/v1/") ||
		strings.HasPrefix(reqPath, "/v2/") ||
		strings.HasPrefix(reqPath, "/api/v2/") ||
		strings.HasPrefix(reqPath, "/nosaver/") ||
		strings.HasPrefix(reqPath, "/v1beta/")

	if isAPIRequest && s.cfg.Limiter != nil && s.proxyGatingEnabled() {
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

				err := s.cfg.Limiter.Acquire(r.Context(), s.cfg.Scope, apiKey, rpm, concurrency, timeout)
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

				defer s.cfg.Limiter.Release(s.cfg.Scope, apiKey)
			}
		}
	}

	// 4. Forward request to upstream Next.js
	s.reverseProxy.ServeHTTP(w, r)
}
