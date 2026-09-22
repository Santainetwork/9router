package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestReadyHandlerReportsUpstreamReadiness(t *testing.T) {
	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/ready" {
			t.Fatalf("readiness probe path = %q, want /api/ready", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ready":true}`))
	}))
	defer healthy.Close()

	unready := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"ready":false,"reason":"schema_missing"}`))
	}))
	defer unready.Close()

	tests := []struct {
		name       string
		upstream   string
		wantStatus int
	}{
		{name: "upstream ready", upstream: healthy.URL, wantStatus: http.StatusOK},
		{name: "upstream unavailable", upstream: "http://127.0.0.1:1", wantStatus: http.StatusServiceUnavailable},
		{name: "upstream reports 503", upstream: unready.URL, wantStatus: http.StatusServiceUnavailable},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/ready", nil)
			rec := httptest.NewRecorder()

			readyHandler(tt.upstream)(rec, req)

			if rec.Code != tt.wantStatus {
				t.Fatalf("ready status = %d, want %d", rec.Code, tt.wantStatus)
			}
		})
	}
}

func TestPublicServerTimeouts(t *testing.T) {
	srv := newPublicServer(":0", http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	if srv.ReadHeaderTimeout != 10*time.Second {
		t.Fatalf("ReadHeaderTimeout = %s, want 10s", srv.ReadHeaderTimeout)
	}
	if srv.ReadTimeout != 5*time.Minute {
		t.Fatalf("ReadTimeout = %s, want 5m", srv.ReadTimeout)
	}
	if srv.IdleTimeout != 120*time.Second {
		t.Fatalf("IdleTimeout = %s, want 120s", srv.IdleTimeout)
	}
}

func TestReadyHandlerRejectsNonGet(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/ready", nil)
	rec := httptest.NewRecorder()

	readyHandler("http://127.0.0.1:1")(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("ready status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}
