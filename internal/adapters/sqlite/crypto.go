package sqlite

// crypto.go — unexported AES-256-GCM helpers for password encryption at rest.
//
// These functions are implementation details of GlobalStore and must not be
// exported. The only consumers are SaveConnection, GetConnection, and
// ListConnections in global.go.
//
// Key derivation: SHA-256(hostname || salt), where salt is a 32-byte random
// value stored in ~/.heydb/key.salt on first use and reused on all subsequent
// calls. This is obfuscation-at-rest, not hardened secret management — the
// goal is to prevent plaintext credentials in the SQLite file, not to resist
// a determined attacker with filesystem access.

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// saltFileName is the name of the salt file inside the heydb home directory.
const saltFileName = "key.salt"

// saltSize is the number of random bytes used as salt.
const saltSize = 32

// ensureSalt reads the salt from heydbDir/key.salt. If the file does not
// exist, it generates a new 32-byte random salt, writes it, and returns it.
// Subsequent calls with the same directory always return the same salt so
// that derived keys remain stable across process restarts.
func ensureSalt(heydbDir string) ([]byte, error) {
	saltPath := filepath.Join(heydbDir, saltFileName)

	data, err := os.ReadFile(saltPath)
	if err == nil {
		// File already exists — return existing salt.
		return data, nil
	}
	if !os.IsNotExist(err) {
		return nil, fmt.Errorf("crypto: read salt file %q: %w", saltPath, err)
	}

	// First run: generate a new salt.
	salt := make([]byte, saltSize)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return nil, fmt.Errorf("crypto: generate salt: %w", err)
	}

	// Ensure the directory exists before writing.
	if err := os.MkdirAll(heydbDir, 0o700); err != nil {
		return nil, fmt.Errorf("crypto: mkdir %q: %w", heydbDir, err)
	}

	if err := os.WriteFile(saltPath, salt, 0o600); err != nil {
		return nil, fmt.Errorf("crypto: write salt file %q: %w", saltPath, err)
	}

	return salt, nil
}

// deriveKey returns a 32-byte AES-256 key derived from hostname and salt via
// SHA-256. This is deterministic: identical inputs always produce the same key.
// Uses only stdlib crypto — no external dependencies introduced.
func deriveKey(hostname string, salt []byte) []byte {
	h := sha256.New()
	h.Write([]byte(hostname))
	h.Write(salt)
	return h.Sum(nil) // SHA-256 output is exactly 32 bytes
}

// encrypt encrypts plaintext with AES-256-GCM using the provided 32-byte key.
// Returns a base64-encoded string of the form: base64(nonce || ciphertext).
// A new random 12-byte nonce is generated on each call, so encrypting the same
// plaintext twice produces different outputs (non-deterministic).
func encrypt(plaintext string, key []byte) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("crypto: new cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("crypto: new GCM: %w", err)
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("crypto: generate nonce: %w", err)
	}

	// Seal appends the ciphertext + GCM tag after the nonce.
	ciphertext := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

// decodeBase64 wraps base64.StdEncoding.DecodeString so that other files in
// this package can perform base64 checks without importing encoding/base64 directly.
func decodeBase64(s string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(s)
}

// decrypt decrypts a base64-encoded ciphertext produced by encrypt.
// Returns the original plaintext, or an error if the ciphertext is malformed,
// too short, or was produced with a different key.
//
// Callers in global.go use this error as a signal for lazy migration:
// a decrypt error on a stored value means it was saved as plaintext before
// encryption was introduced — the caller should re-encrypt and write it back.
func decrypt(ciphertext string, key []byte) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(ciphertext)
	if err != nil {
		return "", fmt.Errorf("crypto: base64 decode: %w", err)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("crypto: new cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("crypto: new GCM: %w", err)
	}

	nonceSize := gcm.NonceSize()
	if len(raw) < nonceSize {
		return "", fmt.Errorf("crypto: ciphertext too short (%d bytes, need at least %d)", len(raw), nonceSize)
	}

	nonce, ciphertextBytes := raw[:nonceSize], raw[nonceSize:]
	plaintext, err := gcm.Open(nil, nonce, ciphertextBytes, nil)
	if err != nil {
		return "", fmt.Errorf("crypto: GCM decrypt: %w", err)
	}

	return string(plaintext), nil
}
