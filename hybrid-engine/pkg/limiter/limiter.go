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
	WindowDuration = 60 * time.Second
	StaleInFlight  = 15 * time.Minute
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
	lastAcquireAt     time.Time
	waiters           []*Waiter
}

type Engine struct {
	mu      sync.RWMutex
	buckets map[string]*Bucket // key: "scope:key"
}

func NewEngine() *Engine {
	e := &Engine{
		buckets: make(map[string]*Bucket),
	}
	go e.watchdogLoop()
	return e
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
	b = &Bucket{
		scope:         scope,
		key:           key,
		windowStart:   time.Now(),
		lastAcquireAt: time.Now(),
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
			}
			b.lastAcquireAt = now
			close(w.done)
		} else {
			break
		}
	}
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
		}
		b.lastAcquireAt = now
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
	}
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
		b.pump()
		b.mu.Unlock()
	}
	return cleared
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
	TotalQueued            int              `json:"totalQueued"`
	TotalActiveConcurrent int              `json:"totalActiveConcurrent"`
	Buckets                []BucketSnapshot `json:"buckets"`
}

func (e *Engine) Snapshot() Snapshot {
	e.mu.RLock()
	defer e.mu.RUnlock()

	now := time.Now()
	var snap Snapshot

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

// Watchdog cleans up stale in-flight locks (>15 minutes without activity)
func (e *Engine) watchdogLoop() {
	ticker := time.NewTicker(1 * time.Minute)
	for range ticker.C {
		now := time.Now()
		e.mu.RLock()
		for _, b := range e.buckets {
			b.mu.Lock()
			if b.activeConcurrency > 0 && now.Sub(b.lastAcquireAt) > StaleInFlight {
				b.activeConcurrency = 0
				b.pump()
			}
			b.mu.Unlock()
		}
		e.mu.RUnlock()
	}
}
