package bootstrap

import (
	"os"
	"path/filepath"
	"testing"
)

func TestHostWithoutPort(t *testing.T) {
	t.Parallel()

	cases := map[string]string{
		"goldmane.calico-system.svc.cluster.local:7443": "goldmane.calico-system.svc.cluster.local",
		"https://goldmane.example.com:7443":             "goldmane.example.com",
		"127.0.0.1:17443":                               "127.0.0.1",
		"goldmane.example.com":                          "goldmane.example.com",
	}

	for input, want := range cases {
		if got := hostWithoutPort(input); got != want {
			t.Fatalf("hostWithoutPort(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestResolveKubeconfigPathPrefersExistingMountedPath(t *testing.T) {
	tempDir := t.TempDir()
	kubeconfig := filepath.Join(tempDir, "config")
	if err := os.WriteFile(kubeconfig, []byte("apiVersion: v1\nkind: Config\n"), 0o600); err != nil {
		t.Fatalf("write kubeconfig: %v", err)
	}

	t.Setenv("KUBECONFIG", kubeconfig)

	got, ok := resolveKubeconfigPath()
	if !ok {
		t.Fatal("expected kubeconfig path to resolve")
	}
	if got != kubeconfig {
		t.Fatalf("resolveKubeconfigPath() = %q, want %q", got, kubeconfig)
	}
}
