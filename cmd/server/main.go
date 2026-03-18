package main

import (
	"context"
	"embed"
	"flag"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"calico-ui/internal/api"
	"calico-ui/internal/bootstrap"
)

//go:embed all:dist
var frontendFS embed.FS

func main() {
	listen := flag.String("listen", ":8080", "HTTP listen address")
	goldmaneAddr := flag.String("goldmane", envOrDefault("GOLDMANE_ADDRESS", "goldmane.calico-system.svc.cluster.local:7443"), "Goldmane gRPC address (advanced direct mode)")
	tlsCert := flag.String("tls-cert", envOrDefault("TLS_CERT_PATH", ""), "TLS client certificate (advanced direct mode)")
	tlsKey := flag.String("tls-key", envOrDefault("TLS_KEY_PATH", ""), "TLS client key (advanced direct mode)")
	tlsCA := flag.String("tls-ca", envOrDefault("TLS_CA_PATH", ""), "TLS CA certificate (advanced direct mode)")
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	applyFlagOverride("GOLDMANE_ADDRESS", *goldmaneAddr)
	applyFlagOverride("TLS_CERT_PATH", *tlsCert)
	applyFlagOverride("TLS_KEY_PATH", *tlsKey)
	applyFlagOverride("TLS_CA_PATH", *tlsCA)

	bootstrapResult := bootstrap.BootstrapGoldmane(logger)
	defer bootstrapResult.Close()

	if bootstrapResult.Client == nil {
		logger.Warn("starting without active Goldmane connection", "mode", bootstrapResult.Status.Mode, "message", bootstrapResult.Status.Message)
	}

	handler := api.NewHandler(bootstrapResult.Client, bootstrapResult.Status, logger)

	appMux := http.NewServeMux()
	handler.RegisterRoutes(appMux)

	// Serve frontend
	distFS, err := fs.Sub(frontendFS, "dist")
	if err != nil {
		logger.Error("frontend dist not found", "err", err)
		os.Exit(1)
	}
	fileServer := http.FileServer(http.FS(distFS))
	appMux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		// Try to serve static file; fallback to index.html for SPA routing
		path := r.URL.Path
		if path == "/" {
			path = "/index.html"
		}
		if f, err := distFS.Open(path[1:]); err == nil {
			f.Close()
			fileServer.ServeHTTP(w, r)
			return
		}
		// SPA fallback
		r.URL.Path = "/"
		fileServer.ServeHTTP(w, r)
	})

	mux := http.NewServeMux()
	mux.Handle("/", stripBasePath("/calico-ui", appMux))

	server := &http.Server{
		Addr:         *listen,
		Handler:      mux,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 0,
		IdleTimeout:  120 * time.Second,
	}

	// Graceful shutdown
	done := make(chan os.Signal, 1)
	signal.Notify(done, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		logger.Info(
			"server starting",
			"addr", *listen,
			"goldmane", bootstrapResult.Status.GoldmaneAddress,
			"mode", bootstrapResult.Status.Mode,
			"ready", bootstrapResult.Status.Ready,
		)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("server error", "err", err)
			os.Exit(1)
		}
	}()

	<-done
	logger.Info("shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	server.Shutdown(ctx)
}

func envOrDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func applyFlagOverride(key, value string) {
	if strings.TrimSpace(value) == "" {
		return
	}
	_ = os.Setenv(key, value)
}

func stripBasePath(basePath string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == basePath || strings.HasPrefix(r.URL.Path, basePath+"/") {
			clone := r.Clone(r.Context())
			urlCopy := *r.URL
			clone.URL = &urlCopy
			clone.URL.Path = strings.TrimPrefix(r.URL.Path, basePath)
			if clone.URL.Path == "" {
				clone.URL.Path = "/"
			}
			next.ServeHTTP(w, clone)
			return
		}

		next.ServeHTTP(w, r)
	})
}
