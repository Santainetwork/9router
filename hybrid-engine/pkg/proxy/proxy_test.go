package proxy

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/santainetwork/9router-hybrid/pkg/limiter"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func TestExtractAPIKey(t *testing.T) {
	tests := []struct {
		name     string
		headers  map[string]string
		expected string
	}{
		{
			name:     "Bearer authorization",
			headers:  map[string]string{"Authorization": "Bearer sk-test-12345"},
			expected: "sk-test-12345",
		},
		{
			name:     "Lowercase bearer",
			headers:  map[string]string{"Authorization": "bearer my-secret-token"},
			expected: "my-secret-token",
		},
		{
			name:     "Bearer with extra whitespace",
			headers:  map[string]string{"Authorization": "Bearer   token-with-spaces   "},
			expected: "token-with-spaces",
		},
		{
			name:     "x-api-key header",
			headers:  map[string]string{"x-api-key": "x-key-999"},
			expected: "x-key-999",
		},
		{
			name:     "api-key header",
			headers:  map[string]string{"api-key": "alt-key-888"},
			expected: "alt-key-888",
		},
		{
			name:     "No key headers",
			headers:  map[string]string{"User-Agent": "curl/7.68.0"},
			expected: "",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req, _ := http.NewRequest("GET", "/v1/models", nil)
			for k, v := range tc.headers {
				req.Header.Set(k, v)
			}
			got := ExtractAPIKey(req)
			if got != tc.expected {
				t.Fatalf("expected key %q, got %q", tc.expected, got)
			}
		})
	}
}

func TestAPIWorkersRoundRobin(t *testing.T) {
	var hits [2]int32
	workers := make([]*httptest.Server, 2)
	for i := range workers {
		i := i
		workers[i] = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/health" {
				w.WriteHeader(http.StatusOK)
				return
			}
			atomic.AddInt32(&hits[i], 1)
			fmt.Fprintf(w, "worker-%d", i)
		}))
		defer workers[i].Close()
	}
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "control") }))
	defer control.Close()
	s, err := NewServer(Config{UpstreamURL: control.URL, APIWorkerURLs: []string{workers[0].URL, workers[1].URL}, AllowAllPaths: true})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for i := 0; i < 4; i++ {
		rr := httptest.NewRecorder()
		s.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/v1/models", nil))
		if rr.Body.String() != fmt.Sprintf("worker-%d", i%2) {
			t.Fatalf("request %d routed to %q", i, rr.Body.String())
		}
	}
}

func TestAPIWorkersRoundRobinSkipsUnhealthyWorkers(t *testing.T) {
	workers := make([]*httptest.Server, 3)
	for i := range workers {
		i := i
		workers[i] = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/health" {
				if i == 1 {
					http.Error(w, "down", http.StatusServiceUnavailable)
					return
				}
				w.WriteHeader(http.StatusOK)
				return
			}
			_, _ = fmt.Fprintf(w, "worker-%d", i)
		}))
		defer workers[i].Close()
	}
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprint(w, "control")
	}))
	defer control.Close()
	s, err := NewServer(Config{
		UpstreamURL:   control.URL,
		APIWorkerURLs: []string{workers[0].URL, workers[1].URL, workers[2].URL},
		AllowAllPaths: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	for i, want := range []string{"worker-0", "worker-2", "worker-0", "worker-2"} {
		rr := httptest.NewRecorder()
		s.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/v1/models", nil))
		if got := rr.Body.String(); got != want {
			t.Fatalf("request %d routed to %q, want %q", i, got, want)
		}
	}
}

func TestAPIWorkersFallbackToControlWhenUnhealthy(t *testing.T) {
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "down", http.StatusServiceUnavailable) }))
	defer worker.Close()
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "control") }))
	defer control.Close()
	s, err := NewServer(Config{UpstreamURL: control.URL, APIWorkerURLs: []string{worker.URL}, AllowAllPaths: true})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	rr := httptest.NewRecorder()
	s.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/api/v2/chat", nil))
	if rr.Body.String() != "control" {
		t.Fatalf("expected control fallback, got %q", rr.Body.String())
	}
}

func TestDashboardNeverRoutedToAPIWorker(t *testing.T) {
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "worker") }))
	defer worker.Close()
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "control") }))
	defer control.Close()
	s, err := NewServer(Config{UpstreamURL: control.URL, APIWorkerURLs: []string{worker.URL}, AllowAllPaths: true})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	rr := httptest.NewRecorder()
	s.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/dashboard", nil))
	if rr.Body.String() != "control" {
		t.Fatalf("expected dashboard on control, got %q", rr.Body.String())
	}
}

func TestAPIWorkerRoutesAllSupportedAPIPrefixes(t *testing.T) {
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/health" {
			w.WriteHeader(http.StatusOK)
			return
		}
		_, _ = fmt.Fprint(w, "worker")
	}))
	defer worker.Close()
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprint(w, "control")
	}))
	defer control.Close()
	s, err := NewServer(Config{UpstreamURL: control.URL, APIWorkerURLs: []string{worker.URL}, AllowAllPaths: true})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	for _, path := range []string{"/nosaver/chat/completions", "/v1beta/models"} {
		t.Run(path, func(t *testing.T) {
			rr := httptest.NewRecorder()
			s.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, path, nil))
			if rr.Body.String() != "worker" {
				t.Fatalf("expected %s on API worker, got %q", path, rr.Body.String())
			}
		})
	}
}

func TestAllowedPathsForwarded(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Upstream-Path", r.URL.Path)
		w.Header().Set("X-Upstream-Method", r.Method)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("upstream-ok"))
	}))
	defer upstream.Close()

	proxySrv, err := NewServer(Config{
		UpstreamURL: upstream.URL,
	})
	if err != nil {
		t.Fatalf("failed to create proxy: %v", err)
	}

	testPaths := []string{
		"/v1/chat/completions",
		"/api/v1/models",
		"/api/v1/usage",
		"/v2/messages",
		"/api/v2/chat",
		"/nosaver/chat/completions",
		"/v1beta/embeddings",
		"/manifest.webmanifest",
		"/favicon.ico",
		"/favicon.svg",
	}

	for _, path := range testPaths {
		t.Run("path_"+path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			rr := httptest.NewRecorder()

			proxySrv.ServeHTTP(rr, req)

			if rr.Code != http.StatusOK {
				t.Fatalf("expected 200 for %s, got %d", path, rr.Code)
			}
			if gotPath := rr.Header().Get("X-Upstream-Path"); gotPath != path {
				t.Fatalf("expected upstream path %s, got %s", path, gotPath)
			}
			if body := rr.Body.String(); body != "upstream-ok" {
				t.Fatalf("expected upstream-ok, got %s", body)
			}
		})
	}
}

func TestDisallowedPathsRejected404(t *testing.T) {
	var upstreamCalls int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&upstreamCalls, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	proxySrv, err := NewServer(Config{
		UpstreamURL: upstream.URL,
	})
	if err != nil {
		t.Fatalf("failed to create proxy: %v", err)
	}

	disallowed := []string{
		"/dashboard",
		"/admin",
		"/login",
		"/api/keys",
		"/api/providers",
		"/api/settings",
		"/other/random/path",
	}

	for _, path := range disallowed {
		t.Run("disallowed_"+path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			rr := httptest.NewRecorder()

			proxySrv.ServeHTTP(rr, req)

			if rr.Code != http.StatusNotFound {
				t.Fatalf("expected 404 for %s, got %d", path, rr.Code)
			}
		})
	}

	if calls := atomic.LoadInt32(&upstreamCalls); calls != 0 {
		t.Fatalf("upstream server was contacted %d times, expected 0", calls)
	}
}

func TestStaticUsageCheckAndDocs(t *testing.T) {
	tempDir := t.TempDir()
	usageContent := "<!DOCTYPE html><html><body>Neobrutalism Usage Check</body></html>"
	docsContent := "<!DOCTYPE html><html><body>SantaiNetwork API Docs</body></html>"

	if err := os.WriteFile(filepath.Join(tempDir, "usage-check.html"), []byte(usageContent), 0644); err != nil {
		t.Fatalf("failed to write usage-check.html: %v", err)
	}
	if err := os.WriteFile(filepath.Join(tempDir, "docs.html"), []byte(docsContent), 0644); err != nil {
		t.Fatalf("failed to write docs.html: %v", err)
	}

	var upstreamCalls int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&upstreamCalls, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	proxySrv, err := NewServer(Config{
		UpstreamURL: upstream.URL,
		StaticDir:   tempDir,
	})
	if err != nil {
		t.Fatalf("failed to create proxy: %v", err)
	}

	// Test /usage-check and /usage-check/
	for _, p := range []string{"/usage-check", "/usage-check/"} {
		req := httptest.NewRequest(http.MethodGet, p, nil)
		rr := httptest.NewRecorder()
		proxySrv.ServeHTTP(rr, req)

		if rr.Code != http.StatusOK {
			t.Fatalf("expected 200 for %s, got %d", p, rr.Code)
		}
		if ct := rr.Header().Get("Content-Type"); ct != "text/html; charset=utf-8" {
			t.Fatalf("expected text/html; charset=utf-8, got %s", ct)
		}
		if cc := rr.Header().Get("Cache-Control"); cc != "no-store" {
			t.Fatalf("expected Cache-Control: no-store, got %s", cc)
		}
		if rr.Body.String() != usageContent {
			t.Fatalf("body mismatch for %s", p)
		}
	}

	// Test /docs, /docs/, /
	for _, p := range []string{"/docs", "/docs/", "/"} {
		req := httptest.NewRequest(http.MethodGet, p, nil)
		rr := httptest.NewRecorder()
		proxySrv.ServeHTTP(rr, req)

		if rr.Code != http.StatusOK {
			t.Fatalf("expected 200 for %s, got %d", p, rr.Code)
		}
		if ct := rr.Header().Get("Content-Type"); ct != "text/html; charset=utf-8" {
			t.Fatalf("expected text/html; charset=utf-8, got %s", ct)
		}
		if cc := rr.Header().Get("Cache-Control"); cc != "no-store" {
			t.Fatalf("expected Cache-Control: no-store, got %s", cc)
		}
		if rr.Body.String() != docsContent {
			t.Fatalf("body mismatch for %s", p)
		}
	}

	if calls := atomic.LoadInt32(&upstreamCalls); calls != 0 {
		t.Fatalf("upstream called %d times during static serve, expected 0", calls)
	}

	// Test missing file fallback: missing docs -> 404, missing usage-check falls through to upstream (not 500)
	emptyDir := t.TempDir()
	fallbackProxy, _ := NewServer(Config{
		UpstreamURL: upstream.URL,
		StaticDir:   emptyDir,
	})

	req404 := httptest.NewRequest(http.MethodGet, "/docs", nil)
	rr404 := httptest.NewRecorder()
	fallbackProxy.ServeHTTP(rr404, req404)
	if rr404.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for missing docs, got %d", rr404.Code)
	}

	// When usage-check.html is missing, proxy falls through to upstream instead of 500
	req500 := httptest.NewRequest(http.MethodGet, "/usage-check", nil)
	rr500 := httptest.NewRecorder()
	fallbackProxy.ServeHTTP(rr500, req500)
	if rr500.Code == http.StatusInternalServerError {
		t.Fatalf("expected proxy fallthrough for missing usage-check, got 500")
	}
}

func TestStreamingSSEFlushedImmediately(t *testing.T) {
	syncChan := make(chan struct{})

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "flusher unsupported", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()

		_, _ = fmt.Fprintf(w, "data: chunk1\n\n")
		flusher.Flush()

		// Wait for reader to verify chunk1 arrived before writing chunk2
		<-syncChan

		_, _ = fmt.Fprintf(w, "data: chunk2\n\n")
		flusher.Flush()
	}))
	defer upstream.Close()

	proxySrv, err := NewServer(Config{
		UpstreamURL: upstream.URL,
	})
	if err != nil {
		t.Fatalf("failed to create proxy: %v", err)
	}

	testServer := httptest.NewServer(proxySrv)
	defer testServer.Close()

	resp, err := http.Get(testServer.URL + "/v1/chat/completions")
	if err != nil {
		t.Fatalf("failed to connect to proxy: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("expected text/event-stream, got %s", ct)
	}

	reader := bufio.NewReader(resp.Body)

	// Read chunk 1 line
	line1, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("failed reading line1: %v", err)
	}
	if !strings.Contains(line1, "data: chunk1") {
		t.Fatalf("expected chunk1, got %s", line1)
	}

	// Read chunk 1 blank line
	lineBlank, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("failed reading blank line: %v", err)
	}
	if strings.TrimSpace(lineBlank) != "" {
		t.Fatalf("expected empty line, got %s", lineBlank)
	}

	// Unblock upstream now that chunk1 has been confirmed flushed and received
	close(syncChan)

	// Read chunk 2
	line2, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("failed reading line2: %v", err)
	}
	if !strings.Contains(line2, "data: chunk2") {
		t.Fatalf("expected chunk2, got %s", line2)
	}
}

func TestGatewayDynamicLimitsDoNotAcquire(t *testing.T) {
	eng := limiter.NewEngine()
	defer eng.Stop()

	const testKey = "dynamic-gateway-key"
	if err := eng.Acquire(context.Background(), "apikey", testKey, 0, 1, 0); err != nil {
		t.Fatalf("failed to pre-acquire test slot: %v", err)
	}
	defer eng.Release("apikey", testKey)

	var upstreamCalls int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&upstreamCalls, 1)
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	proxySrv, err := NewServer(Config{
		UpstreamURL:   upstream.URL,
		Limiter:       eng,
		AllowAllPaths: true,
		QueueTimeout:  10 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("failed to create proxy: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+testKey)
	rr := httptest.NewRecorder()
	proxySrv.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected dynamic gateway request to forward, got %d", rr.Code)
	}
	if calls := atomic.LoadInt32(&upstreamCalls); calls != 1 {
		t.Fatalf("expected one upstream call, got %d", calls)
	}
	if active := eng.GetBucketDetail("apikey", testKey).ActiveConcurrency; active != 1 {
		t.Fatalf("dynamic gateway path acquired or released the existing slot, active = %d", active)
	}
}

func TestClientAbortTriggersRelease(t *testing.T) {
	eng := limiter.NewEngine()
	defer eng.Stop()

	inFlightChan := make(chan struct{})
	var isFirst int32 = 1

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.CompareAndSwapInt32(&isFirst, 1, 0) {
			close(inFlightChan)
			// Wait for client abort
			<-r.Context().Done()
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer upstream.Close()

	proxySrv, err := NewServer(Config{
		UpstreamURL:    upstream.URL,
		Limiter:        eng,
		KeyConcurrency: 1,
		QueueTimeout:   5 * time.Second,
		Scope:          "apikey",
	})
	if err != nil {
		t.Fatalf("failed to create proxy: %v", err)
	}

	testServer := httptest.NewServer(proxySrv)
	defer testServer.Close()

	testKey := "test-abort-key"
	ctx, cancel := context.WithCancel(context.Background())

	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, testServer.URL+"/v1/chat/completions", nil)
	req.Header.Set("Authorization", "Bearer "+testKey)

	clientErrCh := make(chan error, 1)
	go func() {
		client := &http.Client{Timeout: 10 * time.Second}
		_, err := client.Do(req)
		clientErrCh <- err
	}()

	// Wait until upstream has received the request
	select {
	case <-inFlightChan:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for upstream to receive request")
	}

	// Verify in-flight slot is active
	detail := eng.GetBucketDetail("apikey", testKey)
	if detail.ActiveConcurrency != 1 {
		t.Fatalf("expected active concurrency 1, got %d", detail.ActiveConcurrency)
	}

	// Abort the client request
	cancel()

	// Wait for client.Do to finish (should report canceled)
	<-clientErrCh

	// Wait for slot to be released
	released := false
	for i := 0; i < 50; i++ {
		time.Sleep(20 * time.Millisecond)
		detail = eng.GetBucketDetail("apikey", testKey)
		if detail.ActiveConcurrency == 0 {
			released = true
			break
		}
	}

	if !released {
		t.Fatalf("concurrency slot was not released after client abort; active = %d", detail.ActiveConcurrency)
	}

	// Verify next request succeeds immediately without blocking
	req2, _ := http.NewRequest(http.MethodGet, testServer.URL+"/v1/chat/completions", nil)
	req2.Header.Set("Authorization", "Bearer "+testKey)
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatalf("second request failed: %v", err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 for second request, got %d", resp2.StatusCode)
	}
}

func TestClientAbortReleasesAfterReverseProxyReturns(t *testing.T) {
	eng := limiter.NewEngine()
	defer eng.Stop()

	proxySrv, err := NewServer(Config{
		Limiter:        eng,
		KeyConcurrency: 1,
		QueueTimeout:   time.Second,
	})
	if err != nil {
		t.Fatalf("failed to create proxy: %v", err)
	}

	roundTripStarted := make(chan struct{})
	allowReturn := make(chan struct{})
	proxySrv.reverseProxy.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		close(roundTripStarted)
		<-allowReturn
		return nil, context.Canceled
	})

	const testKey = "abort-lifecycle-key"
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil).WithContext(ctx)
	req.Header.Set("Authorization", "Bearer "+testKey)
	rr := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		proxySrv.ServeHTTP(rr, req)
		close(done)
	}()

	<-roundTripStarted
	cancel()
	time.Sleep(20 * time.Millisecond)
	if active := eng.GetBucketDetail("apikey", testKey).ActiveConcurrency; active != 1 {
		t.Fatalf("released before ReverseProxy.ServeHTTP returned, active = %d", active)
	}

	close(allowReturn)
	<-done
	if active := eng.GetBucketDetail("apikey", testKey).ActiveConcurrency; active != 0 {
		t.Fatalf("expected one release after ReverseProxy.ServeHTTP returned, active = %d", active)
	}
}

func TestProxyReleasesOwnedLeaseOnly(t *testing.T) {
	eng := limiter.NewEngine()
	defer eng.Stop()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	}))
	defer upstream.Close()

	proxySrv, err := NewServer(Config{
		UpstreamURL:    upstream.URL,
		Limiter:        eng,
		KeyConcurrency: 1,
		Scope:          "apikey",
	})
	if err != nil {
		t.Fatalf("failed to create proxy: %v", err)
	}

	const testKey = "owned-release-key"

	// RPM-only request: no concurrency grant, so no lease is owned and no
	// release must occur (otherwise it would be counted as an unknown release).
	rpmOnly := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	rpmOnly.Header.Set("Authorization", "Bearer "+testKey)
	rpmOnlyRR := httptest.NewRecorder()
	proxySrv.cfg.KeyConcurrency = 0
	proxySrv.cfg.KeyRPM = 5
	proxySrv.ServeHTTP(rpmOnlyRR, rpmOnly)
	if rpmOnlyRR.Code != http.StatusOK {
		t.Fatalf("rpm-only request should forward, got %d", rpmOnlyRR.Code)
	}
	if unknown := eng.UnknownReleases("apikey", testKey); unknown != 0 {
		t.Fatalf("rpm-only request caused an unknown release, count=%d", unknown)
	}

	// Concurrency request: owns a lease and must release it exactly.
	proxySrv.cfg.KeyConcurrency = 1
	proxySrv.cfg.KeyRPM = 0
	concReq := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	concReq.Header.Set("Authorization", "Bearer "+testKey)
	concRR := httptest.NewRecorder()
	proxySrv.ServeHTTP(concRR, concReq)
	if concRR.Code != http.StatusOK {
		t.Fatalf("concurrency request should forward, got %d", concRR.Code)
	}
	if active := eng.GetBucketDetail("apikey", testKey).ActiveConcurrency; active != 0 {
		t.Fatalf("concurrency lease leaked after request, active=%d", active)
	}
	if unknown := eng.UnknownReleases("apikey", testKey); unknown != 0 {
		t.Fatalf("owned release must not count as unknown, count=%d", unknown)
	}
}

func TestProxyRateLimitedRequestReleasesNoLease(t *testing.T) {
	eng := limiter.NewEngine()
	defer eng.Stop()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	proxySrv, err := NewServer(Config{
		UpstreamURL:    upstream.URL,
		Limiter:        eng,
		KeyConcurrency: 1,
		QueueTimeout:   10 * time.Millisecond,
		Scope:          "apikey",
	})
	if err != nil {
		t.Fatalf("failed to create proxy: %v", err)
	}

	const testKey = "rejected-no-release-key"
	if err := eng.Acquire(context.Background(), "apikey", testKey, 0, 1, 0); err != nil {
		t.Fatalf("failed to pre-acquire slot: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+testKey)
	rr := httptest.NewRecorder()
	proxySrv.ServeHTTP(rr, req)
	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429, got %d", rr.Code)
	}
	if unknown := eng.UnknownReleases("apikey", testKey); unknown != 0 {
		t.Fatalf("rejected request must not release a lease, unknown count=%d", unknown)
	}
}

func TestRateLimitExceededReturns429(t *testing.T) {
	eng := limiter.NewEngine()
	defer eng.Stop()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	proxySrv, err := NewServer(Config{
		UpstreamURL:    upstream.URL,
		Limiter:        eng,
		KeyConcurrency: 1,
		QueueTimeout:   10 * time.Millisecond,
		Scope:          "apikey",
	})
	if err != nil {
		t.Fatalf("failed to create proxy: %v", err)
	}

	testKey := "busy-key"

	// Pre-consume the 1 slot
	if err := eng.Acquire(context.Background(), "apikey", testKey, 0, 1, 0); err != nil {
		t.Fatalf("failed to acquire test slot: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	req.Header.Set("Authorization", "Bearer "+testKey)
	rr := httptest.NewRecorder()

	proxySrv.ServeHTTP(rr, req)

	if rr.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 Too Many Requests, got %d", rr.Code)
	}
	if retryAfter := rr.Header().Get("Retry-After"); retryAfter != "1" {
		t.Fatalf("expected Retry-After: 1, got %s", retryAfter)
	}

	var errBody struct {
		Error struct {
			Message string `json:"message"`
			Type    string `json:"type"`
			Code    int    `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(rr.Body).Decode(&errBody); err != nil {
		t.Fatalf("failed to parse 429 response JSON: %v", err)
	}
	if errBody.Error.Code != 429 {
		t.Fatalf("expected error code 429, got %d", errBody.Error.Code)
	}
}

func TestParseWorkerURL(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		want    string // normalized String(); empty when invalid
		wantErr bool
	}{
		{name: "http loopback ipv4", in: "http://127.0.0.1:20131", want: "http://127.0.0.1:20131"},
		{name: "scheme omitted ipv4", in: "127.0.0.1:20131", want: "http://127.0.0.1:20131"},
		{name: "localhost", in: "http://localhost:20131", want: "http://localhost:20131"},
		{name: "ipv6 loopback", in: "http://[::1]:20131", want: "http://[::1]:20131"},
		{name: "trailing slash normalized", in: "http://127.0.0.1:20131/", want: "http://127.0.0.1:20131"},
		{name: "https loopback", in: "https://127.0.0.1:8443", want: "https://127.0.0.1:8443"},

		{name: "ftp scheme", in: "ftp://127.0.0.1:20131", wantErr: true},
		{name: "ftp scheme prefixed bug", in: "ftp://host", wantErr: true},
		{name: "external host name", in: "http://example.com:20131", wantErr: true},
		{name: "external ip", in: "http://10.0.0.5:20131", wantErr: true},
		{name: "no port", in: "http://127.0.0.1", wantErr: true},
		{name: "port zero", in: "http://127.0.0.1:0", wantErr: true},
		{name: "port out of range", in: "http://127.0.0.1:70000", wantErr: true},
		{name: "path", in: "http://127.0.0.1:20131/v1", wantErr: true},
		{name: "query", in: "http://127.0.0.1:20131?x=1", wantErr: true},
		{name: "fragment", in: "http://127.0.0.1:20131#frag", wantErr: true},
		{name: "userinfo", in: "http://user:pass@127.0.0.1:20131", wantErr: true},
		{name: "malformed", in: "http://127.0.0.1:notaport", wantErr: true},
		{name: "empty", in: "   ", wantErr: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseWorkerURL(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error for %q, got %v", tc.in, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error for %q: %v", tc.in, err)
			}
			if got.String() != tc.want {
				t.Fatalf("parseWorkerURL(%q) = %q, want %q", tc.in, got.String(), tc.want)
			}
		})
	}
}

func TestNewServerRejectsInvalidWorkerURL(t *testing.T) {
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "control") }))
	defer control.Close()

	for _, bad := range []string{
		"ftp://127.0.0.1:20131",
		"http://example.com:20131",
		"http://127.0.0.1",
		"http://127.0.0.1:0",
		"http://127.0.0.1:20131/v1",
		"http://user@127.0.0.1:20131",
	} {
		t.Run(bad, func(t *testing.T) {
			if _, err := NewServer(Config{UpstreamURL: control.URL, APIWorkerURLs: []string{bad}, AllowAllPaths: true}); err == nil {
				t.Fatalf("expected NewServer to reject %q", bad)
			}
		})
	}
}

func TestWorkerHealthURLResolvesPath(t *testing.T) {
	u, err := parseWorkerURL("http://127.0.0.1:20131")
	if err != nil {
		t.Fatal(err)
	}
	if got := workerHealthURL(u); got != "http://127.0.0.1:20131/api/health" {
		t.Fatalf("workerHealthURL = %q", got)
	}
}
