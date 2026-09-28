package proxy

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// Task 7 gateway failover tests. A readyStatus of 0 means 200; any other value
// is returned verbatim for the /api/ready probe.
func controlServer(readyStatus int) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/ready" {
			if readyStatus == 0 {
				w.WriteHeader(http.StatusOK)
				return
			}
			w.WriteHeader(readyStatus)
			return
		}
		_, _ = fmt.Fprint(w, "control")
	}))
}

func workerServer(readyStatus int) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/ready" {
			if readyStatus == 0 {
				w.WriteHeader(http.StatusOK)
				return
			}
			w.WriteHeader(readyStatus)
			return
		}
		_, _ = fmt.Fprint(w, "worker")
	}))
}

func TestWorkerProviderRefusalReplaysToHealthyControlBeforeClientResponse(t *testing.T) {
	var workerHits atomic.Int32
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/ready" {
			w.WriteHeader(http.StatusOK)
			return
		}
		workerHits.Add(1)
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("X-9Router-Worker-Refusal", "PROVIDER_NOT_WORKER_SAFE")
		w.WriteHeader(http.StatusConflict)
		_, _ = fmt.Fprint(w, "worker refusal")
	}))
	defer worker.Close()

	var controlHits atomic.Int32
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/ready" {
			w.WriteHeader(http.StatusOK)
			return
		}
		controlHits.Add(1)
		body, _ := io.ReadAll(r.Body)
		_, _ = fmt.Fprintf(w, "control:%s", body)
	}))
	defer control.Close()

	s, err := NewServer(Config{
		UpstreamURL:     control.URL,
		APIWorkerURLs:   []string{worker.URL},
		ControlFallback: true,
		AllowAllPaths:   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"unsafe/m","messages":[]}`))
	s.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK || rr.Body.String() != `control:{"model":"unsafe/m","messages":[]}` {
		t.Fatalf("expected body-preserving control replay, got %d %q", rr.Code, rr.Body.String())
	}
	if workerHits.Load() != 1 || controlHits.Load() != 1 {
		t.Fatalf("expected one worker attempt and one control replay, got worker=%d control=%d", workerHits.Load(), controlHits.Load())
	}
}

func TestWorkerProviderRefusalFailsClosedWithoutExplicitControlFallback(t *testing.T) {
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/ready" {
			w.WriteHeader(http.StatusOK)
			return
		}
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("X-9Router-Worker-Refusal", "PROVIDER_NOT_WORKER_SAFE")
		w.WriteHeader(http.StatusConflict)
	}))
	defer worker.Close()
	control := controlServer(0)
	defer control.Close()

	s, err := NewServer(Config{UpstreamURL: control.URL, APIWorkerURLs: []string{worker.URL}, AllowAllPaths: true})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	rr := httptest.NewRecorder()
	s.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"unsafe/m"}`)))
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected fail-closed 503, got %d %q", rr.Code, rr.Body.String())
	}
	if rr.Header().Get("X-9Router-Worker-Refusal") != "" {
		t.Fatal("internal worker refusal header must not reach clients")
	}
}

func TestAPIWorkersEligibleReadyWorkerRoutesToWorker(t *testing.T) {
	worker := workerServer(0)
	defer worker.Close()
	control := controlServer(0)
	defer control.Close()

	s, err := NewServer(Config{
		UpstreamURL:     control.URL,
		APIWorkerURLs:   []string{worker.URL},
		ControlFallback: true,
		AllowAllPaths:   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	rr := httptest.NewRecorder()
	s.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/v1/models", nil))
	if rr.Body.String() != "worker" {
		t.Fatalf("expected ready worker to serve request, got %q", rr.Body.String())
	}
}

func TestAPIWorkersUnreadyWorkerFallsBackToHealthyControl(t *testing.T) {
	worker := workerServer(http.StatusServiceUnavailable)
	defer worker.Close()
	control := controlServer(0)
	defer control.Close()

	s, err := NewServer(Config{
		UpstreamURL:     control.URL,
		APIWorkerURLs:   []string{worker.URL},
		ControlFallback: true,
		AllowAllPaths:   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	rr := httptest.NewRecorder()
	s.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/api/v2/chat", nil))
	if rr.Body.String() != "control" {
		t.Fatalf("expected healthy direct-write control fallback, got %q", rr.Body.String())
	}
}

func TestAPIWorkersWriterDownWorkerFailsClosed503(t *testing.T) {
	worker := workerServer(http.StatusServiceUnavailable)
	defer worker.Close()
	control := controlServer(http.StatusServiceUnavailable)
	defer control.Close()

	s, err := NewServer(Config{
		UpstreamURL:     control.URL,
		APIWorkerURLs:   []string{worker.URL},
		ControlFallback: true,
		AllowAllPaths:   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	rr := httptest.NewRecorder()
	s.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil))
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when writer barrier failed, got %d (body %q)", rr.Code, rr.Body.String())
	}
}

func TestAPIWorkersControlDown503(t *testing.T) {
	worker := workerServer(http.StatusServiceUnavailable)
	defer worker.Close()
	control := controlServer(http.StatusServiceUnavailable)
	defer control.Close()

	s, err := NewServer(Config{
		UpstreamURL:     control.URL,
		APIWorkerURLs:   []string{worker.URL},
		ControlFallback: true,
		AllowAllPaths:   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	rr := httptest.NewRecorder()
	s.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/api/v2/chat", nil))
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when control is down, got %d (body %q)", rr.Code, rr.Body.String())
	}
}

func TestAPIWorkersNoFallbackUnlessExplicitlyEnabled(t *testing.T) {
	worker := workerServer(http.StatusServiceUnavailable)
	defer worker.Close()
	control := controlServer(0)
	defer control.Close()

	s, err := NewServer(Config{
		UpstreamURL:   control.URL,
		APIWorkerURLs: []string{worker.URL},
		AllowAllPaths: true, // ControlFallback defaults to false
	})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	rr := httptest.NewRecorder()
	s.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil))
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 without explicit control fallback, got %d (body %q)", rr.Code, rr.Body.String())
	}
}

func TestAPIWorkersFallbackRequiresHealthyControl(t *testing.T) {
	worker := workerServer(http.StatusServiceUnavailable)
	defer worker.Close()
	control := controlServer(http.StatusServiceUnavailable)
	defer control.Close()

	s, err := NewServer(Config{
		UpstreamURL:     control.URL,
		APIWorkerURLs:   []string{worker.URL},
		ControlFallback: true,
		AllowAllPaths:   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	rr := httptest.NewRecorder()
	s.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil))
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when control fallback enabled but control unready, got %d (body %q)", rr.Code, rr.Body.String())
	}
}

func TestAPIWorkerRequestWithoutWorkersPreservesControlForwarding(t *testing.T) {
	control := controlServer(http.StatusServiceUnavailable) // control /api/ready down is irrelevant without workers
	defer control.Close()

	s, err := NewServer(Config{
		UpstreamURL:   control.URL,
		AllowAllPaths: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	rr := httptest.NewRecorder()
	s.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil))
	if rr.Body.String() != "control" {
		t.Fatalf("single-process behavior must forward to control, got %q", rr.Body.String())
	}
}

func TestGatewayDeniesPublicReady(t *testing.T) {
	control := controlServer(0)
	defer control.Close()

	for _, allowAll := range []bool{true, false} {
		name := "public"
		if allowAll {
			name = "master"
		}
		t.Run(name, func(t *testing.T) {
			s, err := NewServer(Config{UpstreamURL: control.URL, AllowAllPaths: allowAll})
			if err != nil {
				t.Fatal(err)
			}
			for _, p := range []string{"/ready", "/api/ready"} {
				rr := httptest.NewRecorder()
				s.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, p, nil))
				if rr.Code != http.StatusNotFound {
					t.Fatalf("expected 404 for %s in %s mode, got %d", p, name, rr.Code)
				}
			}
		})
	}
}

func TestControlOnlyRoutesNeverReachWorker(t *testing.T) {
	worker := workerServer(0)
	defer worker.Close()
	control := controlServer(0)
	defer control.Close()

	s, err := NewServer(Config{
		UpstreamURL:     control.URL,
		APIWorkerURLs:   []string{worker.URL},
		ControlFallback: true,
		AllowAllPaths:   true,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	for _, p := range []string{"/health", "/dashboard", "/api/settings"} {
		rr := httptest.NewRecorder()
		s.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, p, nil))
		if rr.Body.String() != "control" {
			t.Fatalf("expected %s on control, got %q", p, rr.Body.String())
		}
	}
}
