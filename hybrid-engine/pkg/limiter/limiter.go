package limiter

import (
	"context"
	"errors"
	"sync"
	"time"
)

var (
	ErrConcurrencyLimit = errors.New("concurrency limit reached")
	ErrRateLimit        = errors.New("rate limit reached")
	ErrQueueTimeout     = errors.New("rate limit / concurrency queue timeout")
)

const (
	WindowDuration   = 60 * time.Second
	StaleSlotTTL     = 5 * time.Minute  // per-slot stale detection (matches JS 5min)
	IdleBucketTTL    = 10 * time.Minute // evict buckets with zero activity
	WatchdogInterval = 30 * time.Second // sweep frequency
)

type Waiter struct {
	done chan struct{}
	err  error
}

type Bucket struct {
	mu                sync.Mutex
	scope             string
	key               string
	windowStart       time.Time
	count             int
	activeConcurrency int
	rpmLast           int
	concurrencyLast   int
	lastActivityAt    time.Time
	inFlightTimes     []time.Time // per-slot acquire timestamps
	waiters           []*Waiter
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

func (b *Bucket) pump() {
	now := time.Now()
	b.roll(now)

	for len(b.waiters) > 0 {
		rpmOk := b.rpmLast <= 0 || b.count < b.rpmLast
		concOk := b.concurrencyLast <= 0 || b.activeConcurrency < b.concurrencyLast

		if rpmOk && concOk {
			w := b.waiters[0]
			b.waiters = b.waiters[1:]
			if b.rpmLast > 0 {
				b.count++
			}
			if b.concurrencyLast > 0 {
				b.activeConcurrency++
				b.inFlightTimes = append(b.inFlightTimes, now)
			}
			b.lastActivityAt = now
			close(w.done)
		} else {
			break
		}
	}
}

// isIdle returns true when the bucket has no waiters, no in-flight slots,
// no RPM window activity, and has been idle longer than IdleBucketTTL.
func (b *Bucket) isIdle(now time.Time) bool {
	return b.activeConcurrency == 0 &&
		len(b.waiters) == 0 &&
		(now.Sub(b.windowStart) >= WindowDuration || b.count == 0) &&
		now.Sub(b.lastActivityAt) >= IdleBucketTTL
}

func (e *Engine) Acquire(ctx context.Context, scope, key string, rpm, concurrency int, timeout time.Duration) error {
	hasRpm := rpm > 0
	hasConc := concurrency > 0
	if !hasRpm && !hasConc {
		return nil
	}

	b := e.getBucket(scope, key)
	b.mu.Lock()
	b.rpmLast = rpm
	b.concurrencyLast = concurrency

	now := time.Now()
	b.roll(now)

	rpmOk := !hasRpm || b.count < rpm
	concOk := !hasConc || b.activeConcurrency < concurrency

	// Direct grant
	if len(b.waiters) == 0 && rpmOk && concOk {
		if hasRpm {
			b.count++
		}
		if hasConc {
			b.activeConcurrency++
			b.inFlightTimes = append(b.inFlightTimes, now)
		}
		b.lastActivityAt = now
		b.mu.Unlock()
		return nil
	}

	// No timeout allowed: immediate rejection
	if timeout <= 0 {
		b.mu.Unlock()
		if hasConc && b.activeConcurrency >= concurrency {
			return ErrConcurrencyLimit
		}
		return ErrRateLimit
	}

	// Queue waiter
	w := &Waiter{done: make(chan struct{})}
	b.waiters = append(b.waiters, w)
	b.mu.Unlock()

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case <-w.done:
		if ctx.Err() != nil {
			e.Release(scope, key)
			return ctx.Err()
		}
		return nil
	case <-timer.C:
		b.mu.Lock()
		for i, item := range b.waiters {
			if item == w {
				b.waiters = append(b.waiters[:i], b.waiters[i+1:]...)
				break
			}
		}
		b.mu.Unlock()
		return ErrQueueTimeout
	case <-ctx.Done():
		b.mu.Lock()
		for i, item := range b.waiters {
			if item == w {
				b.waiters = append(b.waiters[:i], b.waiters[i+1:]...)
				break
			}
		}
		b.mu.Unlock()
		return ctx.Err()
	}
}

func (e *Engine) Release(scope, key string) {
	id := scope + ":" + key
	e.mu.RLock()
	b, ok := e.buckets[id]
	e.mu.RUnlock()
	if !ok {
		return
	}

	b.mu.Lock()
	if b.activeConcurrency > 0 {
		b.activeConcurrency--
		if len(b.inFlightTimes) > 0 {
			b.inFlightTimes = b.inFlightTimes[1:] // FIFO: remove oldest slot
		}
	}
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
	cleared := b.activeConcurrency
	b.activeConcurrency = 0
	b.inFlightTimes = nil
	b.pump()
	b.mu.Unlock()
	return cleared
}

func (e *Engine) ResetAll() int {
	e.mu.RLock()
	defer e.mu.RUnlock()
	cleared := 0
	for _, b := range e.buckets {
		b.mu.Lock()
		cleared += b.activeConcurrency
		b.activeConcurrency = 0
		b.inFlightTimes = nil
		b.pump()
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
		ActiveConcurrency: b.activeConcurrency,
		Queued:            queued,
		InWindow:          inWindow,
		RPM:               b.rpmLast,
		Concurrency:       b.concurrencyLast,
		WindowResetInMs:   resetMs,
	}
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
		active := b.activeConcurrency

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
			Key:               b.key,
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

	// Phase 1: per-slot stale expiry (under read lock to iterate, bucket lock per entry)
	e.mu.RLock()
	for _, b := range e.buckets {
		b.mu.Lock()
		if b.activeConcurrency > 0 && len(b.inFlightTimes) > 0 {
			alive := b.inFlightTimes[:0]
			for _, ts := range b.inFlightTimes {
				if now.Sub(ts) <= StaleSlotTTL {
					alive = append(alive, ts)
				}
			}
			expired := len(b.inFlightTimes) - len(alive)
			if expired > 0 {
				b.inFlightTimes = alive
				b.activeConcurrency = max(0, b.activeConcurrency-expired)
				b.pump()
			}
		} else if b.activeConcurrency > 0 && len(b.inFlightTimes) == 0 {
			// Legacy fallback: no per-slot data, use lastActivityAt
			if now.Sub(b.lastActivityAt) > StaleSlotTTL {
				b.activeConcurrency = 0
				b.pump()
			}
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
