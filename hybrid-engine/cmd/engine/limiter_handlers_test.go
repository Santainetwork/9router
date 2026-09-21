package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/santainetwork/9router-hybrid/pkg/limiter"
)

func TestLimiterAcquireReturnsLeaseID(t *testing.T) {
	eng := limiter.NewEngine()
	defer eng.Stop()

	body := bytes.NewBufferString(`{"scope":"apikey","key":"lease-key","rpm":0,"concurrency":1,"timeoutMs":0}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/limiter/acquire", body)
	rec := httptest.NewRecorder()

	limiterAcquireHandler(eng)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("acquire status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}

	var resp struct {
		Allowed bool   `json:"allowed"`
		LeaseID string `json:"leaseId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("acquire response is not valid JSON: %v (body: %s)", err, rec.Body.String())
	}
	if !resp.Allowed {
		t.Fatalf("acquire response allowed = false, want true")
	}
	if resp.LeaseID == "" {
		t.Fatalf("concurrency acquire must return a non-empty leaseId, got %q", resp.LeaseID)
	}
}

func TestLimiterAcquireRPMOnlyMayReturnEmptyLeaseID(t *testing.T) {
	eng := limiter.NewEngine()
	defer eng.Stop()

	body := bytes.NewBufferString(`{"scope":"apikey","key":"rpm-key","rpm":10,"concurrency":0,"timeoutMs":0}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/limiter/acquire", body)
	rec := httptest.NewRecorder()

	limiterAcquireHandler(eng)(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("rpm-only acquire status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}

	var resp struct {
		Allowed bool   `json:"allowed"`
		LeaseID string `json:"leaseId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("rpm-only acquire response is not valid JSON: %v (body: %s)", err, rec.Body.String())
	}
	if !resp.Allowed {
		t.Fatalf("rpm-only acquire response allowed = false, want true")
	}
	if resp.LeaseID != "" {
		t.Fatalf("rpm-only acquire must return empty leaseId, got %q", resp.LeaseID)
	}
}

func TestLimiterReleaseRequiresLeaseID(t *testing.T) {
	eng := limiter.NewEngine()
	defer eng.Stop()

	// Missing leaseId is rejected where ownership is required.
	body := bytes.NewBufferString(`{"scope":"apikey","key":"lease-key"}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/limiter/release", body)
	rec := httptest.NewRecorder()

	limiterReleaseHandler(eng)(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("release without leaseId status = %d, want 400 (body: %s)", rec.Code, rec.Body.String())
	}
}

func TestLimiterReleaseWithLeaseIDReleasesOwnedSlot(t *testing.T) {
	eng := limiter.NewEngine()
	defer eng.Stop()

	// Acquire a concurrency slot.
	acqBody := bytes.NewBufferString(`{"scope":"apikey","key":"lease-key","rpm":0,"concurrency":1,"timeoutMs":0}`)
	acqReq := httptest.NewRequest(http.MethodPost, "/v1/limiter/acquire", acqBody)
	acqRec := httptest.NewRecorder()
	limiterAcquireHandler(eng)(acqRec, acqReq)

	var acqResp struct {
		Allowed bool   `json:"allowed"`
		LeaseID string `json:"leaseId"`
	}
	if err := json.Unmarshal(acqRec.Body.Bytes(), &acqResp); err != nil || acqResp.LeaseID == "" {
		t.Fatalf("acquire setup failed: err=%v leaseId=%q", err, acqResp.LeaseID)
	}

	// Release with the owned leaseId.
	relBody := bytes.NewBufferString(`{"scope":"apikey","key":"lease-key","leaseId":"` + acqResp.LeaseID + `"}`)
	relReq := httptest.NewRequest(http.MethodPost, "/v1/limiter/release", relBody)
	relRec := httptest.NewRecorder()
	limiterReleaseHandler(eng)(relRec, relReq)

	if relRec.Code != http.StatusOK {
		t.Fatalf("release with leaseId status = %d, want 200 (body: %s)", relRec.Code, relRec.Body.String())
	}

	if got := eng.GetBucketDetail("apikey", "lease-key").ActiveConcurrency; got != 0 {
		t.Fatalf("owned lease not released, activeConcurrency=%d", got)
	}
}
