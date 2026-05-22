package sqlite

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ── deriveKey ─────────────────────────────────────────────────────────────────

func TestDeriveKey_Length(t *testing.T) {
	salt := []byte("testsalt")
	key := deriveKey("testhostname", salt)
	if len(key) != 32 {
		t.Errorf("deriveKey: want 32-byte key, got %d bytes", len(key))
	}
}

func TestDeriveKey_Deterministic(t *testing.T) {
	salt := []byte("testsalt")
	k1 := deriveKey("host", salt)
	k2 := deriveKey("host", salt)
	if string(k1) != string(k2) {
		t.Error("deriveKey: same inputs must produce same key")
	}
}

func TestDeriveKey_DifferentSaltsDifferentKeys(t *testing.T) {
	k1 := deriveKey("host", []byte("salt1"))
	k2 := deriveKey("host", []byte("salt2"))
	if string(k1) == string(k2) {
		t.Error("deriveKey: different salts must produce different keys")
	}
}

func TestDeriveKey_DifferentHostsDifferentKeys(t *testing.T) {
	salt := []byte("testsalt")
	k1 := deriveKey("host1", salt)
	k2 := deriveKey("host2", salt)
	if string(k1) == string(k2) {
		t.Error("deriveKey: different hostnames must produce different keys")
	}
}

// ── ensureSalt ────────────────────────────────────────────────────────────────

func TestEnsureSalt_CreatesFile(t *testing.T) {
	dir := t.TempDir()
	salt, err := ensureSalt(dir)
	if err != nil {
		t.Fatalf("ensureSalt: unexpected error: %v", err)
	}
	if len(salt) == 0 {
		t.Error("ensureSalt: returned empty salt")
	}
	// File must exist.
	saltPath := filepath.Join(dir, "key.salt")
	if _, err := os.Stat(saltPath); os.IsNotExist(err) {
		t.Error("ensureSalt: key.salt file not created")
	}
}

func TestEnsureSalt_Idempotent(t *testing.T) {
	dir := t.TempDir()
	s1, err := ensureSalt(dir)
	if err != nil {
		t.Fatalf("ensureSalt first call: %v", err)
	}
	s2, err := ensureSalt(dir)
	if err != nil {
		t.Fatalf("ensureSalt second call: %v", err)
	}
	if string(s1) != string(s2) {
		t.Error("ensureSalt: subsequent calls must return the same salt")
	}
}

// ── encrypt / decrypt ─────────────────────────────────────────────────────────

func TestEncryptDecrypt_RoundTrip(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}

	plaintext := "super-secret-password"
	ciphertext, err := encrypt(plaintext, key)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if ciphertext == plaintext {
		t.Error("encrypt: ciphertext must not equal plaintext")
	}

	got, err := decrypt(ciphertext, key)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if got != plaintext {
		t.Errorf("decrypt: want %q, got %q", plaintext, got)
	}
}

func TestEncryptDecrypt_EmptyString(t *testing.T) {
	key := make([]byte, 32)
	ciphertext, err := encrypt("", key)
	if err != nil {
		t.Fatalf("encrypt empty: %v", err)
	}
	got, err := decrypt(ciphertext, key)
	if err != nil {
		t.Fatalf("decrypt empty: %v", err)
	}
	if got != "" {
		t.Errorf("decrypt empty: want empty string, got %q", got)
	}
}

func TestDecrypt_WrongKey(t *testing.T) {
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	wrongKey := make([]byte, 32)

	ciphertext, err := encrypt("password", key)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}

	_, err = decrypt(ciphertext, wrongKey)
	if err == nil {
		t.Error("decrypt with wrong key: expected error, got nil")
	}
}

func TestDecrypt_InvalidBase64(t *testing.T) {
	key := make([]byte, 32)
	_, err := decrypt("this is not valid base64!!!", key)
	if err == nil {
		t.Error("decrypt invalid base64: expected error, got nil")
	}
}

func TestDecrypt_TooShort(t *testing.T) {
	// A valid base64 string but shorter than nonce size.
	key := make([]byte, 32)
	_, err := decrypt("aGVsbG8=", key) // base64("hello"), only 5 bytes
	if err == nil {
		t.Error("decrypt too-short ciphertext: expected error, got nil")
	}
}

// ── encrypt uniqueness ────────────────────────────────────────────────────────

func TestEncrypt_UniqueNonces(t *testing.T) {
	key := make([]byte, 32)
	c1, _ := encrypt("password", key)
	c2, _ := encrypt("password", key)
	if c1 == c2 {
		t.Error("encrypt: two encryptions of the same plaintext must produce different ciphertexts (random nonce)")
	}
}

// ── plaintext detection ───────────────────────────────────────────────────────

func TestDecrypt_PlaintextReturnsError(t *testing.T) {
	key := make([]byte, 32)
	// A clearly plain-text password passed directly to decrypt must error,
	// not silently return empty or incorrect output.
	_, err := decrypt("myplainpassword", key)
	if err == nil {
		t.Error("decrypt plaintext: expected error (base64 decode or GCM failure), got nil")
	}
}

func TestDecrypt_ErrorMessageIsDescriptive(t *testing.T) {
	key := make([]byte, 32)
	_, err := decrypt("notbase64!!!", key)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	// The error message must be non-empty and mention something useful.
	if strings.TrimSpace(err.Error()) == "" {
		t.Error("decrypt: error message must not be empty")
	}
}
