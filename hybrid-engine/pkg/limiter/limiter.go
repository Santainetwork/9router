package limiter

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"sync"
	"time"
)

var (
	ErrConcurrencyLimit = errors.New("concurrency limit reached")
	ErrRateLimit        = errors.New("rate limit reached")
	ErrQueueTimeout     = errors.New("rate limit / concurrency queue timeout")
	ErrLimiterReset     = errors.New("limiter reset")
)

const (
	WindowDuration   = 60 * time.Second
	StaleSlotTTL     = 5 * time.Minute  // per-slot stale detection (matches JS 5min)
	IdleBucketTTL    = 10 * time.Minute // evict buckets with zero activity
	WatchdogInterval = 30 * time.Second // sweep frequency
)

type LeaseID string

type waiterState uint8

const (
	waiterWaiting waiterState = iota
	waiterGranted
	waiterCancelled
)

type Waiter struct {
	done    chan struct{}
	state   waiterState
	leaseID LeaseID
	err     error
	legacy  bool
}

type Bucket struct {
	mu              sync.Mutex
	scope           string
	key             string
	windowStart     time.Time
	count           int
	rpmLast         int
	concurrencyLast int
	lastActivityAt  time.Time
	activeLeases    map[LeaseID]time.Time
	legacyLeases    []LeaseID
	waiters         []*Waiter
	unknownReleases uint64
}

type Engine struct {
	mu      sync.RWMutex
	buckets map[string]*Bucket // key: "scope:key"
	stop    chan struct{}
}

func NewEngine() *Engine {
	e := &Engine{
		buckets: make(map[string]*Bucket),
		stop:    make(chan struct{}),
	}
	go e.watchdogLoop()
	return e
}

func (e *Engine) Stop() {
	close(e.stop)
}

func (e *Engine) getBucket(scope, key string) *Bucket {
	id := scope + ":" + key
	e.mu.RLock()
	b, ok := e.buckets[id]
	e.mu.RUnlock()
	if ok {
		return b
	}

	e.mu.Lock()
	defer e.mu.Unlock()
	if b, ok = e.buckets[id]; ok {
		return b
	}
	now := time.Now()
	b = &Bucket{
		scope:          scope,
		key:            key,
		windowStart:    now,
		lastActivityAt: now,
		activeLeases:   make(map[LeaseID]time.Time),
	}
	e.buckets[id] = b
	return b
}

func (b *Bucket) roll(now time.Time) {
	if now.Sub(b.windowStart) >= WindowDuration {
		b.windowStart = now
		b.count = 0
	}
}

func (b *Bucket) grant(now time.Time, hasRPM, hasConcurrency, legacy bool) LeaseID {
	if hasRPM {
		b.count++
	}
	var leaseID LeaseID
	if hasConcurrency {
		for leaseID == "" {
			candidate := LeaseID(rand.Text())
			if _, exists := b.activeLeases[candidate]; !exists {
				leaseID = candidate
			}
		}
		b.activeLeases[leaseID] = now
		if legacy {
			b.legacyLeases = append(b.legacyLeases, leaseID)
		}
	}
	b.lastActivityAt = now
	return leaseID
}

func (b *Bucket) pumpAt(now time.Time) {
	b.roll(now)

	for len(b.waiters) > 0 {
		w := b.waiters[0]
		if w.state != waiterWaiting {
			b.waiters = b.waiters[1:]
			continue
		}
		rpmOk := b.rpmLast <= 0 || b.count < b.rpmLast
		concOk := b.concurrencyLast <= 0 || len(b.activeLeases) < b.concurrencyLast

		if rpmOk && concOk {
			b.waiters = b.waiters[1:]
			w.leaseID = b.grant(now, b.rpmLast > 0, b.concurrencyLast > 0, w.legacy)
			w.state = waiterGranted
			close(w.done)
		} else {
			break
		}
	}
}

func (b *Bucket) pump() {
	b.pumpAt(time.Now())
}

func (b *Bucket) resolveWaiter(w *Waiter, terminalErr error) (LeaseID, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	switch w.state {
	case waiterGranted:
		return w.leaseID, nil
	case waiterCancelled:
		return "", w.err
	}

	for i, item := range b.waiters {
		if item == w {
			b.waiters = append(b.waiters[:i], b.waiters[i+1:]...)
			break
		}
	}
	w.state = waiterCancelled
	w.err = terminalErr
	close(w.done)
	return "", terminalErr
}

// isIdle returns true when the bucket has no waiters, no in-flight slots,
// no RPM window activity, and has been idle longer than IdleBucketTTL.
func (b *Bucket) isIdle(now time.Time) bool {
	return len(b.activeLeases) == 0 &&
		len(b.waiters) == 0 &&
		(now.Sub(b.windowStart) >= WindowDuration || b.count == 0) &&
		now.Sub(b.lastActivityAt) >= IdleBucketTTL
}

func (e *Engine) Acquire(ctx context.Context, scope, key string, rpm, concurrency int, timeout time.Duration) error {
	_, err := e.acquireLease(ctx, scope, key, rpm, concurrency, timeout, true)
	return err
}

func (e *Engine) AcquireLease(ctx context.Context, scope, key string, rpm, concurrency int, timeout time.Duration) (LeaseID, error) {
	return e.acquireLease(ctx, scope, key, rpm, concurrency, timeout, false)
}

func (e *Engine) acquireLease(ctx context.Context, scope, key string, rpm, concurrency int, timeout time.Duration, legacy bool) (LeaseID, error) {
	hasRpm := rpm > 0
	hasConc := concurrency > 0
	if !hasRpm && !hasConc {
		return "", nil
	}

	b := e.getBucket(scope, key)
	b.mu.Lock()
	b.rpmLast = rpm
	b.concurrencyLast = concurrency

	now := time.Now()
	b.roll(now)

	rpmOk := !hasRpm || b.count < rpm
	concOk := !hasConc || len(b.activeLeases) < concurrency

	// Direct grant
	if len(b.waiters) == 0 && rpmOk && concOk {
		leaseID := b.grant(now, hasRpm, hasConc, legacy)
		b.mu.Unlock()
		return leaseID, nil
	}

	// No timeout allowed: immediate rejection
	if timeout <= 0 {
		limitErr := ErrRateLimit
		if hasConc && !concOk {
			limitErr = ErrConcurrencyLimit
		}
		b.mu.Unlock()
		return "", limitErr
	}

	// Queue waiter
	w := &Waiter{done: make(chan struct{}), state: waiterWaiting, legacy: legacy}
	b.waiters = append(b.waiters, w)
	b.mu.Unlock()

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case <-w.done:
		return b.resolveWaiter(w, nil)
	case <-timer.C:
		return b.resolveWaiter(w, ErrQueueTimeout)
	case <-ctx.Done():
		return b.resolveWaiter(w, ctx.Err())
	}
}

// Release accepts one lease ID for owned releases. Omitting it temporarily
// releases only a lease created through the legacy Acquire method.
func (e *Engine) Release(scope, key string, leaseIDs ...LeaseID) {
	id := scope + ":" + key
	e.mu.RLock()
	b, ok := e.buckets[id]
	e.mu.RUnlock()
	if !ok {
		return
	}

	b.mu.Lock()
	var leaseID LeaseID
	if len(leaseIDs) > 0 {
		leaseID = leaseIDs[0]
	} else {
		for len(b.legacyLeases) > 0 {
			leaseID = b.legacyLeases[0]
			b.legacyLeases = b.legacyLeases[1:]
			if _, exists := b.activeLeases[leaseID]; exists {
				break
			}
			leaseID = ""
		}
	}
	if _, exists := b.activeLeases[leaseID]; !exists || leaseID == "" {
		b.unknownReleases++
		b.mu.Unlock()
		return
	}
	delete(b.activeLeases, leaseID)
	b.lastActivityAt = time.Now()
	b.pump()
	b.mu.Unlock()
}

func (e *Engine) Reset(scope, key string) int {
	id := scope + ":" + key
	e.mu.RLock()
	b, ok := e.buckets[id]
	e.mu.RUnlock()
	if !ok {
		return 0
	}

	b.mu.Lock()
	cleared := len(b.activeLeases)
	clear(b.activeLeases)
	b.legacyLeases = nil
	for _, w := range b.waiters {
		if w.state == waiterWaiting {
			w.state = waiterCancelled
			w.err = ErrLimiterReset
			close(w.done)
		}
	}
	b.waiters = nil
	b.lastActivityAt = time.Now()
	b.mu.Unlock()
	return cleared
}

func (e *Engine) ResetAll() int {
	e.mu.RLock()
	defer e.mu.RUnlock()
	cleared := 0
	for _, b := range e.buckets {
		b.mu.Lock()
		cleared += len(b.activeLeases)
		clear(b.activeLeases)
		b.legacyLeases = nil
		for _, w := range b.waiters {
			if w.state == waiterWaiting {
				w.state = waiterCancelled
				w.err = ErrLimiterReset
				close(w.done)
			}
		}
		b.waiters = nil
		b.lastActivityAt = time.Now()
		b.mu.Unlock()
	}
	return cleared
}

// BucketDetail returns telemetry for a single scope:key bucket (used by dashboard).
type BucketDetail struct {
	Count             int   `json:"count"`
	ActiveConcurrency int   `json:"activeConcurrency"`
	Queued            int   `json:"queued"`
	InWindow          int   `json:"inWindow"`
	RPM               int   `json:"rpm"`
	Concurrency       int   `json:"concurrency"`
	WindowResetInMs   int64 `json:"windowResetInMs"`
}

func (e *Engine) GetBucketDetail(scope, key string) BucketDetail {
	id := scope + ":" + key
	e.mu.RLock()
	b, ok := e.buckets[id]
	e.mu.RUnlock()
	if !ok {
		return BucketDetail{}
	}

	now := time.Now()
	b.mu.Lock()
	defer b.mu.Unlock()

	inWindow := 0
	if now.Sub(b.windowStart) < WindowDuration {
		inWindow = b.count
	}

	queued := 0
	for range b.waiters {
		queued++
	}

	resetMs := int64(0)
	diff := WindowDuration - now.Sub(b.windowStart)
	if diff > 0 {
		resetMs = diff.Milliseconds()
	}

	return BucketDetail{
		Count:             b.count,
		ActiveConcurrency: len(b.activeLeases),
		Queued:            queued,
		InWindow:          inWindow,
		RPM:               b.rpmLast,
		Concurrency:       b.concurrencyLast,
		WindowResetInMs:   resetMs,
	}
}

// UnknownReleases returns the number of Release calls that did not match an
// owned lease. Used by tests to assert lease ownership.
func (e *Engine) UnknownReleases(scope, key string) uint64 {
	id := scope + ":" + key
	e.mu.RLock()
	b, ok := e.buckets[id]
	e.mu.RUnlock()
	if !ok {
		return 0
	}

	b.mu.Lock()
	defer b.mu.Unlock()
	return b.unknownReleases
}

// BucketCount returns the number of tracked buckets (for metrics/tests).
func (e *Engine) BucketCount() int {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return len(e.buckets)
}

type BucketSnapshot struct {
	Scope             string `json:"scope"`
	Key               string `json:"key"`
	RPM               int    `json:"rpm"`
	Concurrency       int    `json:"concurrency"`
	ActiveConcurrency int    `json:"activeConcurrency"`
	InWindow          int    `json:"inWindow"`
	Queued            int    `json:"queued"`
	WindowResetInMs   int64  `json:"windowResetInMs"`
}

type Snapshot struct {
	TotalQueued           int              `json:"totalQueued"`
	TotalActiveConcurrent int              `json:"totalActiveConcurrent"`
	TotalBuckets          int              `json:"totalBuckets"`
	Buckets               []BucketSnapshot `json:"buckets"`
}

func snapshotKey(key string) string {
	sum := sha256.Sum256([]byte(key))
	return "sha256:" + hex.EncodeToString(sum[:])
}

func (e *Engine) Snapshot() Snapshot {
	e.mu.RLock()
	defer e.mu.RUnlock()

	now := time.Now()
	snap := Snapshot{TotalBuckets: len(e.buckets)}

	for _, b := range e.buckets {
		b.mu.Lock()
		inWindow := 0
		if now.Sub(b.windowStart) < WindowDuration {
			inWindow = b.count
		}
		queued := len(b.waiters)
		active := len(b.activeLeases)

		if inWindow == 0 && queued == 0 && active == 0 {
			b.mu.Unlock()
			continue
		}

		snap.TotalQueued += queued
		snap.TotalActiveConcurrent += active

		resetMs := int64(0)
		diff := WindowDuration - now.Sub(b.windowStart)
		if diff > 0 {
			resetMs = diff.Milliseconds()
		}

		snap.Buckets = append(snap.Buckets, BucketSnapshot{
			Scope:             b.scope,
			Key:               snapshotKey(b.key),
			RPM:               b.rpmLast,
			Concurrency:       b.concurrencyLast,
			ActiveConcurrency: active,
			InWindow:          inWindow,
			Queued:            queued,
			WindowResetInMs:   resetMs,
		})
		b.mu.Unlock()
	}
	return snap
}

// watchdogLoop runs two maintenance tasks every WatchdogInterval:
//  1. Expire individual stale in-flight slots (per-slot >StaleSlotTTL)
//  2. Evict completely idle buckets (>IdleBucketTTL with no activity)
func (e *Engine) watchdogLoop() {
	ticker := time.NewTicker(WatchdogInterval)
	defer ticker.Stop()
	for {
		select {
		case <-e.stop:
			return
		case <-ticker.C:
			e.watchdogSweep()
		}
	}
}

func (e *Engine) watchdogSweep() {
	now := time.Now()

	// Phase 1: per-lease stale expiry (under read lock to iterate, bucket lock per entry)
	e.mu.RLock()
	for _, b := range e.buckets {
		b.mu.Lock()
		expired := false
		for leaseID, acquiredAt := range b.activeLeases {
			if now.Sub(acquiredAt) > StaleSlotTTL {
				delete(b.activeLeases, leaseID)
				expired = true
			}
		}
		if expired {
			b.pumpAt(now)
		}
		b.mu.Unlock()
	}
	e.mu.RUnlock()

	// Phase 2: evict idle buckets (needs write lock)
	e.mu.Lock()
	for id, b := range e.buckets {
		b.mu.Lock()
		idle := b.isIdle(now)
		b.mu.Unlock()
		if idle {
			delete(e.buckets, id)
		}
	}
	e.mu.Unlock()
}
