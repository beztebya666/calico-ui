package api

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

const sessionCookieName = "calico_ui_session"

type authClaims struct {
	Username string `json:"sub"`
	Expires  int64  `json:"exp"`
}

type authStatusResponse struct {
	Enabled           bool     `json:"enabled"`
	Authenticated     bool     `json:"authenticated"`
	Username          string   `json:"username,omitempty"`
	AllowedNamespaces []string `json:"allowedNamespaces,omitempty"`
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type authContextKey string

const authClaimsKey authContextKey = "calico-ui-auth"

type AuthManager struct {
	enabled           bool
	username          string
	password          string
	secret            []byte
	sessionTTL        time.Duration
	allowedNamespaces map[string]struct{}
	allowedList       []string
	allowAll          bool
	allowedOrigins    map[string]struct{}
	logger            *slog.Logger
}

func newAuthManager(logger *slog.Logger) *AuthManager {
	username := strings.TrimSpace(os.Getenv("AUTH_USERNAME"))
	password := strings.TrimSpace(os.Getenv("AUTH_PASSWORD"))

	if username == "" {
		username = strings.TrimSpace(os.Getenv("AUTH_DEFAULT_USERNAME"))
	}
	if password == "" {
		password = strings.TrimSpace(os.Getenv("AUTH_DEFAULT_PASSWORD"))
	}

	if username == "" && password == "" {
		return &AuthManager{allowAll: true, logger: logger}
	}

	if username == "" || password == "" {
		logger.Warn("auth disabled because AUTH_USERNAME and AUTH_PASSWORD must be set together")
		return &AuthManager{allowAll: true, logger: logger}
	}

	secret := []byte(strings.TrimSpace(os.Getenv("AUTH_SESSION_SECRET")))
	if len(secret) == 0 {
		secret = make([]byte, 32)
		if _, err := rand.Read(secret); err != nil {
			sum := sha256.Sum256([]byte(username + ":" + password))
			secret = sum[:]
		}
		logger.Warn("using ephemeral auth session secret; set AUTH_SESSION_SECRET for stable sessions")
	}

	ttlHours, err := strconv.Atoi(strings.TrimSpace(os.Getenv("AUTH_SESSION_TTL_HOURS")))
	if err != nil || ttlHours < 1 {
		ttlHours = 12
	}

	allowedNamespaces := map[string]struct{}{}
	allowedList := make([]string, 0)
	allowAll := true
	rawNamespaces := strings.TrimSpace(os.Getenv("AUTH_ALLOWED_NAMESPACES"))
	if rawNamespaces != "" && rawNamespaces != "*" {
		allowAll = false
		for _, value := range strings.Split(rawNamespaces, ",") {
			namespace := strings.TrimSpace(value)
			if namespace == "" {
				continue
			}
			if namespace == "*" {
				allowAll = true
				allowedNamespaces = map[string]struct{}{}
				allowedList = nil
				break
			}
			if _, exists := allowedNamespaces[namespace]; exists {
				continue
			}
			allowedNamespaces[namespace] = struct{}{}
			allowedList = append(allowedList, namespace)
		}
		sort.Strings(allowedList)
	}

	allowedOrigins := map[string]struct{}{}
	for _, value := range strings.Split(strings.TrimSpace(os.Getenv("ALLOWED_ORIGINS")), ",") {
		origin := normalizeOrigin(value)
		if origin == "" {
			continue
		}
		allowedOrigins[origin] = struct{}{}
	}

	return &AuthManager{
		enabled:           true,
		username:          username,
		password:          password,
		secret:            secret,
		sessionTTL:        time.Duration(ttlHours) * time.Hour,
		allowedNamespaces: allowedNamespaces,
		allowedList:       allowedList,
		allowAll:          allowAll,
		allowedOrigins:    allowedOrigins,
		logger:            logger,
	}
}

func (a *AuthManager) Require(next http.Handler) http.Handler {
	if !a.enabled {
		return next
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, ok := a.claimsFromRequest(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "authentication required")
			return
		}

		ctx := context.WithValue(r.Context(), authClaimsKey, claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (a *AuthManager) HandleStatus(w http.ResponseWriter, r *http.Request) {
	status := authStatusResponse{
		Enabled:           a.enabled,
		AllowedNamespaces: append([]string(nil), a.allowedList...),
	}

	if !a.enabled {
		status.Authenticated = true
		writeJSON(w, http.StatusOK, status)
		return
	}

	claims, ok := a.claimsFromRequest(r)
	status.Authenticated = ok
	if ok {
		status.Username = claims.Username
	}
	writeJSON(w, http.StatusOK, status)
}

func (a *AuthManager) HandleLogin(w http.ResponseWriter, r *http.Request) {
	if !a.enabled {
		writeJSON(w, http.StatusOK, authStatusResponse{Enabled: false, Authenticated: true})
		return
	}

	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid login payload")
		return
	}

	if subtle.ConstantTimeCompare([]byte(strings.TrimSpace(req.Username)), []byte(a.username)) != 1 ||
		subtle.ConstantTimeCompare([]byte(req.Password), []byte(a.password)) != 1 {
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}

	if err := a.setSessionCookie(w, r, a.username); err != nil {
		a.logger.Error("set auth cookie", "err", err)
		writeInternalError(w, "failed to create authenticated session")
		return
	}

	writeJSON(w, http.StatusOK, authStatusResponse{
		Enabled:           true,
		Authenticated:     true,
		Username:          a.username,
		AllowedNamespaces: append([]string(nil), a.allowedList...),
	})
}

func (a *AuthManager) HandleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		MaxAge:   -1,
		SameSite: http.SameSiteLaxMode,
		Secure:   isSecureRequest(r),
	})
	writeJSON(w, http.StatusOK, map[string]string{"status": "logged out"})
}

func (a *AuthManager) NamespaceAllowed(namespace string) bool {
	if !a.enabled || a.allowAll {
		return true
	}

	switch strings.TrimSpace(namespace) {
	case "", "-":
		return true
	default:
		_, ok := a.allowedNamespaces[namespace]
		return ok
	}
}

func (a *AuthManager) ClusterAccessAllowed() bool {
	return !a.enabled || a.allowAll
}

func (a *AuthManager) CheckOrigin(r *http.Request) bool {
	origin := normalizeOrigin(r.Header.Get("Origin"))
	if origin == "" {
		return false
	}

	if _, ok := a.allowedOrigins[origin]; ok {
		return true
	}

	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}

	requestScheme := "http"
	if isSecureRequest(r) {
		requestScheme = "https"
	}

	return strings.EqualFold(parsed.Host, r.Host) && strings.EqualFold(parsed.Scheme, requestScheme)
}

func (a *AuthManager) claimsFromRequest(r *http.Request) (authClaims, bool) {
	if !a.enabled {
		return authClaims{Username: "anonymous"}, true
	}

	cookie, err := r.Cookie(sessionCookieName)
	if err != nil {
		return authClaims{}, false
	}

	return a.parseSession(cookie.Value)
}

func (a *AuthManager) setSessionCookie(w http.ResponseWriter, r *http.Request, username string) error {
	claims := authClaims{
		Username: username,
		Expires:  time.Now().Add(a.sessionTTL).Unix(),
	}

	value, err := a.signClaims(claims)
	if err != nil {
		return err
	}

	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   isSecureRequest(r),
		MaxAge:   int(a.sessionTTL.Seconds()),
	})

	return nil
}

func (a *AuthManager) signClaims(claims authClaims) (string, error) {
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}

	encodedPayload := base64.RawURLEncoding.EncodeToString(payload)
	signature := a.sign(encodedPayload)
	return encodedPayload + "." + signature, nil
}

func (a *AuthManager) parseSession(value string) (authClaims, bool) {
	parts := strings.Split(value, ".")
	if len(parts) != 2 {
		return authClaims{}, false
	}

	payload, signature := parts[0], parts[1]
	expected := a.sign(payload)
	if subtle.ConstantTimeCompare([]byte(signature), []byte(expected)) != 1 {
		return authClaims{}, false
	}

	rawPayload, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return authClaims{}, false
	}

	var claims authClaims
	if err := json.Unmarshal(rawPayload, &claims); err != nil {
		return authClaims{}, false
	}

	if claims.Username == "" || claims.Expires < time.Now().Unix() {
		return authClaims{}, false
	}

	return claims, true
}

func (a *AuthManager) sign(value string) string {
	mac := hmac.New(sha256.New, a.secret)
	mac.Write([]byte(value))
	return hex.EncodeToString(mac.Sum(nil))
}

func normalizeOrigin(origin string) string {
	origin = strings.TrimSpace(origin)
	if origin == "" {
		return ""
	}

	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}

	parsed.Path = ""
	parsed.RawPath = ""
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String()
}

func isSecureRequest(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}

	return strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https")
}
