package facilitator

import (
	"context"
	"errors"
	"sync"
)

// Faults are consumed by sequential requests; the concurrent tests use the
// synchronized in-memory store directly.
type closeAccountingFaultStore struct {
	PendingSettlementStore
	marker  string
	failGet bool
	failSet bool
}

func (s *closeAccountingFaultStore) Get(ctx context.Context, key string) (string, bool, error) {
	if key == s.marker && s.failGet {
		s.failGet = false
		return "", false, errors.New("accounting marker read failed")
	}
	return s.PendingSettlementStore.Get(ctx, key)
}

func (s *closeAccountingFaultStore) Set(ctx context.Context, key, value string) error {
	if key == s.marker && s.failSet {
		s.failSet = false
		return errors.New("accounting marker write failed")
	}
	return s.PendingSettlementStore.Set(ctx, key, value)
}

// The cached-result path only reads Done when joining an existing accounting
// pass. Signal that wait so concurrency tests can release the owner deterministically.
type closeAccountingWaitContext struct {
	context.Context
	once    sync.Once
	waiting chan struct{}
}

func (c *closeAccountingWaitContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.waiting) })
	return c.Context.Done()
}
