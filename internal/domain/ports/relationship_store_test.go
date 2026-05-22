package ports_test

import (
	"context"
	"testing"

	"github.com/pvidaal07/heydb/internal/domain/ports"
	"github.com/pvidaal07/heydb/internal/domain/schema"
)

// stubRelationshipStore is a minimal implementation used only for the
// compile-time interface satisfaction check below.
type stubRelationshipStore struct{}

func (s *stubRelationshipStore) AddRelationship(_ context.Context, rel schema.ImplicitRelationship) (schema.ImplicitRelationship, error) {
	return rel, nil
}

func (s *stubRelationshipStore) DeleteRelationship(_ context.Context, _ string) error {
	return nil
}

func (s *stubRelationshipStore) ListRelationships(_ context.Context, _, _ string) ([]schema.ImplicitRelationship, error) {
	return nil, nil
}

func (s *stubRelationshipStore) GetRelationshipsByTable(_ context.Context, _, _, _ string) ([]schema.ImplicitRelationship, error) {
	return nil, nil
}


// Compile-time assertion: stubRelationshipStore must satisfy ports.RelationshipStore.
var _ ports.RelationshipStore = (*stubRelationshipStore)(nil)

// TestRelationshipStore_InterfaceExists is a sentinel test — it fails to build
// if RelationshipStore is not defined or has the wrong method set.
func TestRelationshipStore_InterfaceExists(t *testing.T) {
	var store ports.RelationshipStore = &stubRelationshipStore{}
	if store == nil {
		t.Fatal("RelationshipStore interface is nil — should not happen")
	}
}
