package limiter

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestAcquireNoLimitsAlwaysGranted(t *testing.T) {
	e := NewEngine()
	defer e.Stop()
	if err := e.Acquire(context.Background(), "apikey", "k1", 0, 0, 0); err != nil {
		t.Fatalf("expected nil error with no limits, got %v", err)
	}
	if e.BucketCount() != 0 {
		t.Fatalf("no-limit acquire should not create a bucket, got %d buckets", e.BucketCount())
	}
}

func TestConcurrencyLimitDirectGrantAndReject(t *testing.T) {
	e := NewEngine()
	defer e.Stop()

	if err := e.Acquire(context.Background(), "apikey", "k2", 0, 1, 0); err != nil {
		t.Fatalf("first acquire should succeed: %v", err)
	}

	err := e.Acquire(context.Background(), "apikey", "k2", 0, 1, 0)
	if err != ErrConcurrencyLimit {
		t.Fatalf("expected ErrConcurrencyLimit, got %v", err)
	}

	e.Release("apikey", "k2")
	if err := e.Acquire(context.Background(), "apikey", "k2", 0, 1, 0); err != nil {
		t.Fatalf("acquire after release should succeed: %v", err)
	}
}

func TestRPMLimitDirectGrantAndReject(t *testing.T) {
	e := NewEngine()
	defer e.Stop()

	for i := 0; i < 3; i++ {
		if err := e.Acquire(context.Background(), "apikey", "rpm1", 3, 0, 0); err != nil {
			t.Fatalf("grant %d should succeed: %v", i, err)
		}
	}
	if err := e.Acquire(context.Background(), "apikey", "rpm1", 3, 0, 0); err != ErrRateLimit {
		t.Fatalf("4th grant should reject with ErrRateLimit, got %v", err)
	}
}

func TestQueueTimeoutRejects(t *testing.T) {
	e := NewEngine()
	defer e.Stop()

	if err := e.Acquire(context.Background(), "apikey", "q1", 0, 1, 0); err != nil {
		t.Fatalf("first acquire should succeed: %v", err)
	}

	start := time.Now()
	err := e.Acquire(context.Background(), "apikey", "q1", 0, 1, 50*time.Millisecond)
	elapsed := time.Since(start)

	if err != ErrQueueTimeout {
		t.Fatalf("expected ErrQueueTimeout, got %v", err)
	}
	if elapsed < 45*time.Millisecond {
		t.Fatalf("expected to wait ~50ms, only waited %v", elapsed)
	}
}

func TestQueueDrainsOnRelease(t *testing.T) {
	e := NewEngine()
	defer e.Stop()

	if err := e.Acquire(context.Background(), "apikey", "q2", 0, 1, 0); err != nil {
		t.Fatalf("first acquire should succeed: %v", err)
	}

	done := make(chan error, 1)
	go func() {
		done <- e.Acquire(context.Background(), "apikey", "q2", 0, 1, 2*time.Second)
	}()

	// Give the waiter time to enqueue.
	time.Sleep(20 * time.Millisecond)
	e.Release("apikey", "q2")

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("queued acquire should succeed after release, got %v", err)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("queued acquire did not resolve within 1s of release")
	}
}

func TestContextCancellationAbortsWaiter(t *testing.T) {
	e := NewEngine()
	defer e.Stop()

	if err := e.Acquire(context.Background(), "apikey", "ctx1", 0, 1, 0); err != nil {
		t.Fatalf("first acquire should succeed: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- e.Acquire(ctx, "apikey", "ctx1", 0, 1, 2*time.Second)
	}()

	time.Sleep(20 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected context cancellation error, got nil")
		}
	case <-time.After(1 * time.Second):
		t.Fatal("cancelled waiter did not resolve within 1s")
	}
}

func TestResetClearsActiveConcurrency(t *testing.T) {
	e := NewEngine()
	defer e.Stop()

	e.Acquire(context.Background(), "apikey", "r1", 0, 2, 0)
	e.Acquire(context.Background(), "apikey", "r1", 0, 2, 0)

	cleared := e.Reset("apikey", "r1")
	if cleared != 2 {
		t.Fatalf("expected 2 cleared, got %d", cleared)
	}

	detail := e.GetBucketDetail("apikey", "r1")
	if detail.ActiveConcurrency != 0 {
		t.Fatalf("expected activeConcurrency 0 after reset, got %d", detail.ActiveConcurrency)
	}
}

func TestResetAllClearsEveryBucket(t *testing.T) {
	e := NewEngine()
	defer e.Stop()

	e.Acquire(context.Background(), "apikey", "ra1", 0, 1, 0)
	e.Acquire(context.Background(), "provider", "ra2", 0, 1, 0)

	cleared := e.ResetAll()
	if cleared != 2 {
		t.Fatalf("expected 2 cleared across all buckets, got %d", cleared)
	}
}

func TestGetBucketDetailUnknownBucketReturnsZeroValue(t *testing.T) {
	e := NewEngine()
	defer e.Stop()

	detail := e.GetBucketDetail("apikey", "nonexistent")
	if detail.ActiveConcurrency != 0 || detail.Queued != 0 || detail.Count != 0 {
		t.Fatalf("expected zero-value detail for unknown bucket, got %+v", detail)
	}
}

func TestSnapshotSkipsIdleBucketsAndReportsTotals(t *testing.T) {
	e := NewEngine()
	defer e.Stop()

	e.Acquire(context.Background(), "apikey", "s1", 0, 2, 0)
	e.Acquire(context.Background(), "apikey", "s1", 0, 2, 0)

	snap := e.Snapshot()
	if snap.TotalActiveConcurrent != 2 {
		t.Fatalf("expected totalActiveConcurrent 2, got %d", snap.TotalActiveConcurrent)
	}
	if len(snap.Buckets) != 1 {
		t.Fatalf("expected exactly 1 active bucket in snapshot, got %d", len(snap.Buckets))
	}
}

// TestPerSlotStaleExpiry verifies the watchdog reclaims individual stale slots
// (not the whole bucket) once StaleSlotTTL elapses, matching the JS behavior
// of tracking inFlightTimes per acquire rather than a single lastActivityAt.
func TestPerSlotStaleExpiry(t *testing.T) {
	e := NewEngine()
	defer e.Stop()

	b := e.getBucket("apikey", "stale1")
	b.mu.Lock()
	b.concurrencyLast = 2
	// Slot 1: stale (acquired long ago)
	b.activeConcurrency = 2
	b.inFlightTimes = []time.Time{
		time.Now().Add(-10 * time.Minute), // stale, older than StaleSlotTTL
		time.Now(),                        // fresh
	}
	b.mu.Unlock()

	e.watchdogSweep()

	detail := e.GetBucketDetail("apikey", "stale1")
	if detail.ActiveConcurrency != 1 {
		t.Fatalf("expected 1 remaining active slot after stale sweep, got %d", detail.ActiveConcurrency)
	}
}

// TestIdleBucketEviction verifies buckets with zero activity for longer than
// IdleBucketTTL are removed from the map entirely, preventing unbounded growth
// from one-off API keys / connections that are later deleted.
func TestIdleBucketEviction(t *testing.T) {
	e := NewEngine()
	defer e.Stop()

	// Create a bucket via direct grant+release, then simulate it aging out.
	e.Acquire(context.Background(), "apikey", "idle1", 0, 1, 0)
	e.Release("apikey", "idle1")

	if e.BucketCount() != 1 {
		t.Fatalf("expected 1 bucket before eviction, got %d", e.BucketCount())
	}

	// Force the bucket to look idle beyond IdleBucketTTL.
	e.mu.RLock()
	b := e.buckets["apikey:idle1"]
	e.mu.RUnlock()
	b.mu.Lock()
	b.lastActivityAt = time.Now().Add(-IdleBucketTTL - time.Second)
	b.windowStart = time.Now().Add(-IdleBucketTTL - time.Second)
	b.mu.Unlock()

	e.watchdogSweep()

	if e.BucketCount() != 0 {
		t.Fatalf("expected bucket to be evicted after idle TTL, got %d buckets remaining", e.BucketCount())
	}
}

// TestActiveBucketNeverEvictedWhileInFlight ensures the eviction sweep never
// removes a bucket that still has in-flight concurrency or queued waiters,
// even if lastActivityAt looks old (defensive: activeConcurrency check first).
func TestActiveBucketNeverEvictedWhileInFlight(t *testing.T) {
	e := NewEngine()
	defer e.Stop()

	e.Acquire(context.Background(), "apikey", "active1", 0, 1, 0)

	e.mu.RLock()
	b := e.buckets["apikey:active1"]
	e.mu.RUnlock()
	b.mu.Lock()
	b.lastActivityAt = time.Now().Add(-IdleBucketTTL - time.Second)
	b.mu.Unlock()

	e.watchdogSweep()

	if e.BucketCount() != 1 {
		t.Fatal("bucket with active concurrency must never be evicted regardless of lastActivityAt")
	}
}

// TestConcurrentAcquireReleaseNoRace exercises the engine under concurrent
// load with -race to catch data races in the bucket map / per-bucket mutex.
func TestConcurrentAcquireReleaseNoRace(t *testing.T) {
	e := NewEngine()
	defer e.Stop()

	var wg sync.WaitGroup
	const workers = 20
	const itersPerWorker = 25

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			key := "race-key"
			for j := 0; j < itersPerWorker; j++ {
				err := e.Acquire(context.Background(), "apikey", key, 0, 5, 200*time.Millisecond)
				if err == nil {
					time.Sleep(time.Millisecond)
					e.Release("apikey", key)
				}
			}
		}(i)
	}
	wg.Wait()

	detail := e.GetBucketDetail("apikey", "race-key")
	if detail.ActiveConcurrency != 0 {
		t.Fatalf("expected all slots released after concurrent run, got %d active", detail.ActiveConcurrency)
	}
}

// TestBucketCountReflectsMultipleScopes verifies distinct scope:key pairs
// create independent buckets (apikey vs provider isolation).
func TestBucketCountReflectsMultipleScopes(t *testing.T) {
	e := NewEngine()
	defer e.Stop()

	e.Acquire(context.Background(), "apikey", "iso1", 1, 0, 0)
	e.Acquire(context.Background(), "provider", "iso1", 1, 0, 0)

	if e.BucketCount() != 2 {
		t.Fatalf("expected 2 independent buckets for same key different scope, got %d", e.BucketCount())
	}
}

// TestMassBucketEvictionReclaimsAll is the direct empirical proof for the
// memory-leak fix this package exists to provide: the JS limiter (rateLimiter.js)
// keeps one Map entry per scope:key forever. Here, 500 transient buckets
// (simulating one-off API keys / provider connections that are later deleted)
// are fully reclaimed once they age past IdleBucketTTL and the watchdog sweeps.
func TestMassBucketEvictionReclaimsAll(t *testing.T) {
	e := NewEngine()
	defer e.Stop()

	const N = 500
	for i := 0; i < N; i++ {
		key := "transient-" + string(rune(i%26+'a')) + string(rune(i/26+'a'))
		e.Acquire(context.Background(), "apikey", key, 0, 1, 0)
		e.Release("apikey", key)
	}

	created := e.BucketCount()
	if created == 0 {
		t.Fatal("expected buckets to be created")
	}
	t.Logf("buckets created: %d", created)

	// Age every bucket past IdleBucketTTL.
	e.mu.RLock()
	for _, b := range e.buckets {
		b.mu.Lock()
		b.lastActivityAt = time.Now().Add(-IdleBucketTTL - time.Second)
		b.windowStart = time.Now().Add(-IdleBucketTTL - time.Second)
		b.mu.Unlock()
	}
	e.mu.RUnlock()

	e.watchdogSweep()

	remaining := e.BucketCount()
	t.Logf("buckets remaining after sweep: %d (reclaimed %d)", remaining, created-remaining)
	if remaining != 0 {
		t.Fatalf("expected all %d idle buckets reclaimed, %d still retained (LEAK)", created, remaining)
	}
}
