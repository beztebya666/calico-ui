package api

import (
	"log/slog"
	"net/http/httptest"
	"testing"
	"time"
)

func TestAuthManagerSessionRoundTrip(t *testing.T) {
	manager := &AuthManager{
		enabled:    true,
		username:   "admin",
		password:   "secret",
		secret:     []byte("unit-test-secret"),
		sessionTTL: time.Hour,
		logger:     slog.Default(),
	}

	token, err := manager.signClaims(authClaims{
		Username: "admin",
		Expires:  time.Now().Add(time.Hour).Unix(),
	})
	if err != nil {
		t.Fatalf("signClaims failed: %v", err)
	}

	claims, ok := manager.parseSession(token)
	if !ok {
		t.Fatalf("expected valid session token")
	}
	if claims.Username != "admin" {
		t.Fatalf("unexpected username: %s", claims.Username)
	}
}

func TestAuthManagerCheckOrigin(t *testing.T) {
	manager := &AuthManager{
		logger: slog.Default(),
	}

	request := httptest.NewRequest("GET", "http://ui.example.com/api/v1/ws/flows", nil)
	request.Host = "ui.example.com"
	request.Header.Set("Origin", "http://ui.example.com")

	if !manager.CheckOrigin(request) {
		t.Fatalf("expected same-origin websocket request to be allowed")
	}

	request.Header.Set("Origin", "http://evil.example.com")
	if manager.CheckOrigin(request) {
		t.Fatalf("expected foreign origin websocket request to be rejected")
	}
}
