package bootstrap

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"calico-ui/internal/goldmane"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/tools/portforward"
	"k8s.io/client-go/transport/spdy"
)

const (
	defaultGoldmaneAddress   = "goldmane.calico-system.svc.cluster.local:7443"
	defaultGoldmaneNamespace = "calico-system"
	defaultGoldmaneService   = "goldmane"
	defaultGoldmanePort      = 7443
	defaultTLSSecret         = "whisker-backend-key-pair"
	defaultCAConfigMap       = "whisker-ca-bundle"
	defaultKubeconfigPath    = "/config/kubeconfig"
)

type Mode string

const (
	ModeInCluster       Mode = "in-cluster"
	ModeExternalKubecfg Mode = "external-kubeconfig"
	ModeDirectGoldmane  Mode = "direct-goldmane"
	ModeUnconfigured    Mode = "unconfigured"
)

type Status struct {
	Ready            bool     `json:"ready"`
	Mode             string   `json:"mode"`
	Message          string   `json:"message"`
	GoldmaneAddress  string   `json:"goldmaneAddress,omitempty"`
	ServerName       string   `json:"serverName,omitempty"`
	KubeconfigPath   string   `json:"kubeconfigPath,omitempty"`
	InCluster        bool     `json:"inCluster"`
	RequiresRestart  bool     `json:"requiresRestart,omitempty"`
	Instructions     []string `json:"instructions,omitempty"`
	ConnectionSource string   `json:"connectionSource,omitempty"`
}

type Result struct {
	Client *goldmane.Client
	Status Status
	close  func()
}

func (r Result) Close() {
	if r.close != nil {
		r.close()
	}
	if r.Client != nil {
		_ = r.Client.Close()
	}
}

func BootstrapGoldmane(logger *slog.Logger) Result {
	inCluster := detectInCluster()
	var inClusterFailure Result
	if inCluster {
		res := bootstrapInCluster(logger)
		if res.Client != nil {
			return res
		}
		inClusterFailure = res
	}

	if hasExplicitGoldmaneAddress() {
		res := bootstrapDirect(logger)
		if res.Client != nil {
			return res
		}
		// Direct mode was explicitly requested; keep its failure details unless kubeconfig succeeds.
		if kubeconfigPath, ok := resolveKubeconfigPath(); ok {
			if fallback := bootstrapFromKubeconfig(kubeconfigPath, logger); fallback.Client != nil {
				return fallback
			}
		}
		return res
	}

	if kubeconfigPath, ok := resolveKubeconfigPath(); ok {
		res := bootstrapFromKubeconfig(kubeconfigPath, logger)
		if res.Client != nil {
			return res
		}
		return res
	}

	if inClusterFailure.Status.Mode != "" {
		return inClusterFailure
	}

	status := Status{
		Ready:           false,
		Mode:            string(ModeUnconfigured),
		Message:         "Calico UI is running, but it is not connected to a cluster yet.",
		InCluster:       inCluster,
		RequiresRestart: true,
		Instructions: []string{
			"In Kubernetes: deploy the app inside the cluster with the bundled Deployment and ServiceAccount. No kubeconfig is required in the browser.",
			fmt.Sprintf("Outside Kubernetes: mount a kubeconfig file into the container at %s (or set KUBECONFIG to another path) and restart the container.", defaultKubeconfigPath),
			fmt.Sprintf("Example: docker run -p 8080:8080 -v $HOME/.kube/config:%s:ro <image>", defaultKubeconfigPath),
			"Advanced mode: set GOLDMANE_ADDRESS and mount TLS files if you expose Goldmane directly.",
		},
	}
	return Result{Status: status}
}

func bootstrapInCluster(logger *slog.Logger) Result {
	addr := envOrDefault("GOLDMANE_ADDRESS", defaultGoldmaneAddress)
	serverName := envOrDefault("GOLDMANE_TLS_SERVER_NAME", hostWithoutPort(addr))
	client, err := goldmane.NewClientWithServerName(
		addr,
		strings.TrimSpace(os.Getenv("TLS_CERT_PATH")),
		strings.TrimSpace(os.Getenv("TLS_KEY_PATH")),
		strings.TrimSpace(os.Getenv("TLS_CA_PATH")),
		serverName,
		logger,
	)
	if err == nil {
		return Result{
			Client: client,
			Status: Status{
				Ready:            true,
				Mode:             string(ModeInCluster),
				Message:          "Connected to Goldmane using in-cluster service discovery.",
				GoldmaneAddress:  addr,
				ServerName:       serverName,
				InCluster:        true,
				ConnectionSource: "serviceaccount + in-cluster DNS",
			},
		}
	}

	return Result{
		Status: Status{
			Ready:           false,
			Mode:            string(ModeInCluster),
			Message:         fmt.Sprintf("In-cluster connection failed: %v", err),
			GoldmaneAddress: addr,
			ServerName:      serverName,
			InCluster:       true,
			Instructions: []string{
				"Verify Goldmane DNS/service reachability from inside the cluster.",
				"Verify TLS_CERT_PATH, TLS_KEY_PATH, and TLS_CA_PATH point to mounted files.",
			},
		},
	}
}

func bootstrapDirect(logger *slog.Logger) Result {
	addr := strings.TrimSpace(os.Getenv("GOLDMANE_ADDRESS"))
	serverName := envOrDefault("GOLDMANE_TLS_SERVER_NAME", hostWithoutPort(addr))
	client, err := goldmane.NewClientWithServerName(
		addr,
		strings.TrimSpace(os.Getenv("TLS_CERT_PATH")),
		strings.TrimSpace(os.Getenv("TLS_KEY_PATH")),
		strings.TrimSpace(os.Getenv("TLS_CA_PATH")),
		serverName,
		logger,
	)
	if err == nil {
		return Result{
			Client: client,
			Status: Status{
				Ready:            true,
				Mode:             string(ModeDirectGoldmane),
				Message:          "Connected directly to Goldmane using explicit runtime settings.",
				GoldmaneAddress:  addr,
				ServerName:       serverName,
				InCluster:        detectInCluster(),
				ConnectionSource: "explicit GOLDMANE_ADDRESS",
			},
		}
	}

	return Result{
		Status: Status{
			Ready:           false,
			Mode:            string(ModeDirectGoldmane),
			Message:         fmt.Sprintf("Direct Goldmane connection failed: %v", err),
			GoldmaneAddress: addr,
			ServerName:      serverName,
			InCluster:       detectInCluster(),
			Instructions: []string{
				"Verify GOLDMANE_ADDRESS is reachable from the container.",
				"Mount TLS_CERT_PATH, TLS_KEY_PATH, and TLS_CA_PATH if Goldmane requires mTLS.",
				"Set GOLDMANE_TLS_SERVER_NAME if the server certificate does not match the address host.",
			},
		},
	}
}

func bootstrapFromKubeconfig(kubeconfigPath string, logger *slog.Logger) Result {
	cfg, err := clientcmd.BuildConfigFromFlags("", kubeconfigPath)
	if err != nil {
		return Result{
			Status: Status{
				Ready:           false,
				Mode:            string(ModeExternalKubecfg),
				Message:         fmt.Sprintf("Failed to load kubeconfig: %v", err),
				KubeconfigPath:  kubeconfigPath,
				InCluster:       detectInCluster(),
				RequiresRestart: true,
				Instructions: []string{
					"Mount a valid kubeconfig into the container and restart it.",
					fmt.Sprintf("Expected path: %s", kubeconfigPath),
				},
			},
		}
	}

	cfg.Timeout = 15 * time.Second

	clientset, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return Result{
			Status: Status{
				Ready:           false,
				Mode:            string(ModeExternalKubecfg),
				Message:         fmt.Sprintf("Failed to create Kubernetes client: %v", err),
				KubeconfigPath:  kubeconfigPath,
				InCluster:       detectInCluster(),
				RequiresRestart: true,
			},
		}
	}

	namespace := envOrDefault("GOLDMANE_NAMESPACE", defaultGoldmaneNamespace)
	serviceName := envOrDefault("GOLDMANE_SERVICE_NAME", defaultGoldmaneService)
	service, err := clientset.CoreV1().Services(namespace).Get(context.Background(), serviceName, metav1.GetOptions{})
	if err != nil {
		return Result{
			Status: Status{
				Ready:           false,
				Mode:            string(ModeExternalKubecfg),
				Message:         fmt.Sprintf("Failed to resolve Goldmane service %s/%s: %v", namespace, serviceName, err),
				KubeconfigPath:  kubeconfigPath,
				InCluster:       detectInCluster(),
				RequiresRestart: true,
				Instructions: []string{
					"Verify the kubeconfig points to the correct cluster.",
					"Override GOLDMANE_NAMESPACE or GOLDMANE_SERVICE_NAME if your install uses different names.",
				},
			},
		}
	}

	pod, err := selectServicePod(context.Background(), clientset, namespace, service)
	if err != nil {
		return Result{
			Status: Status{
				Ready:           false,
				Mode:            string(ModeExternalKubecfg),
				Message:         fmt.Sprintf("Failed to resolve Goldmane pod behind %s/%s: %v", namespace, serviceName, err),
				KubeconfigPath:  kubeconfigPath,
				InCluster:       detectInCluster(),
				RequiresRestart: true,
			},
		}
	}

	remotePort := readGoldmanePort(service)
	serverName := envOrDefault("GOLDMANE_TLS_SERVER_NAME", buildServiceServerName(serviceName, namespace))
	stopForward, localAddr, err := startPortForward(cfg, namespace, pod.Name, remotePort)
	if err != nil {
		return Result{
			Status: Status{
				Ready:           false,
				Mode:            string(ModeExternalKubecfg),
				Message:         fmt.Sprintf("Failed to port-forward Goldmane pod %s/%s: %v", namespace, pod.Name, err),
				KubeconfigPath:  kubeconfigPath,
				InCluster:       detectInCluster(),
				ServerName:      serverName,
				RequiresRestart: true,
			},
		}
	}

	tempDir, certFile, keyFile, caFile, err := writeTLSMaterial(context.Background(), clientset, namespace)
	if err != nil {
		stopForward()
		return Result{
			Status: Status{
				Ready:           false,
				Mode:            string(ModeExternalKubecfg),
				Message:         fmt.Sprintf("Failed to fetch Goldmane TLS material from cluster: %v", err),
				KubeconfigPath:  kubeconfigPath,
				InCluster:       detectInCluster(),
				ServerName:      serverName,
				RequiresRestart: true,
				Instructions: []string{
					"Override GOLDMANE_TLS_SECRET or GOLDMANE_CA_CONFIGMAP if your install uses different resource names.",
				},
			},
		}
	}

	client, err := goldmane.NewClientWithServerName(localAddr, certFile, keyFile, caFile, serverName, logger)
	if err != nil {
		stopForward()
		_ = os.RemoveAll(tempDir)
		return Result{
			Status: Status{
				Ready:           false,
				Mode:            string(ModeExternalKubecfg),
				Message:         fmt.Sprintf("Failed to connect to Goldmane through kubeconfig bootstrap: %v", err),
				KubeconfigPath:  kubeconfigPath,
				InCluster:       detectInCluster(),
				GoldmaneAddress: localAddr,
				ServerName:      serverName,
				RequiresRestart: true,
			},
		}
	}

	return Result{
		Client: client,
		Status: Status{
			Ready:            true,
			Mode:             string(ModeExternalKubecfg),
			Message:          "Connected to Goldmane through a Kubernetes API tunnel created from the mounted kubeconfig.",
			KubeconfigPath:   kubeconfigPath,
			GoldmaneAddress:  localAddr,
			ServerName:       serverName,
			InCluster:        detectInCluster(),
			ConnectionSource: fmt.Sprintf("kubeconfig -> pod/%s port-forward", pod.Name),
		},
		close: func() {
			stopForward()
			_ = os.RemoveAll(tempDir)
		},
	}
}

func detectInCluster() bool {
	if strings.TrimSpace(os.Getenv("KUBERNETES_SERVICE_HOST")) == "" {
		return false
	}
	if _, err := os.Stat("/var/run/secrets/kubernetes.io/serviceaccount/token"); err != nil {
		return false
	}
	return true
}

func resolveKubeconfigPath() (string, bool) {
	seen := map[string]struct{}{}
	candidates := make([]string, 0, 8)

	for _, raw := range filepath.SplitList(strings.TrimSpace(os.Getenv("KUBECONFIG"))) {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		candidates = append(candidates, raw)
	}

	candidates = append(candidates, defaultKubeconfigPath, "/kubeconfig")

	if home, err := os.UserHomeDir(); err == nil && home != "" {
		candidates = append(candidates, filepath.Join(home, ".kube", "config"))
	}

	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		if _, ok := seen[candidate]; ok {
			continue
		}
		seen[candidate] = struct{}{}
		info, err := os.Stat(candidate)
		if err == nil && !info.IsDir() {
			return candidate, true
		}
	}
	return "", false
}

func hasExplicitGoldmaneAddress() bool {
	value := strings.TrimSpace(os.Getenv("GOLDMANE_ADDRESS"))
	return value != "" && value != defaultGoldmaneAddress
}

func hostWithoutPort(addr string) string {
	host := strings.TrimSpace(addr)
	if host == "" {
		return ""
	}
	if strings.Contains(host, "://") {
		if parsed, err := url.Parse(host); err == nil {
			host = parsed.Host
		}
	}
	if strings.Contains(host, ":") {
		if trimmed, _, found := strings.Cut(host, ":"); found {
			return trimmed
		}
	}
	return host
}

func envOrDefault(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func buildServiceServerName(serviceName, namespace string) string {
	return fmt.Sprintf("%s.%s.svc.cluster.local", serviceName, namespace)
}

func selectServicePod(ctx context.Context, clientset kubernetes.Interface, namespace string, service *corev1.Service) (*corev1.Pod, error) {
	selector := labels.SelectorFromSet(service.Spec.Selector).String()
	if selector == "" {
		selector = "app.kubernetes.io/name=goldmane"
	}

	pods, err := clientset.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{LabelSelector: selector})
	if err != nil {
		return nil, err
	}
	if len(pods.Items) == 0 {
		return nil, fmt.Errorf("no pods matched selector %q", selector)
	}

	for i := range pods.Items {
		pod := &pods.Items[i]
		if pod.Status.Phase != corev1.PodRunning {
			continue
		}
		if pod.DeletionTimestamp != nil {
			continue
		}
		for _, condition := range pod.Status.Conditions {
			if condition.Type == corev1.PodReady && condition.Status == corev1.ConditionTrue {
				return pod, nil
			}
		}
	}

	return &pods.Items[0], nil
}

func readGoldmanePort(service *corev1.Service) int {
	if value, err := strconv.Atoi(strings.TrimSpace(os.Getenv("GOLDMANE_PORT"))); err == nil && value > 0 {
		return value
	}

	for _, port := range service.Spec.Ports {
		if port.Port == defaultGoldmanePort {
			return int(port.Port)
		}
		if port.Name == "grpc" || port.Name == "https" || port.Name == "goldmane" {
			return int(port.Port)
		}
	}
	if len(service.Spec.Ports) > 0 {
		return int(service.Spec.Ports[0].Port)
	}
	return defaultGoldmanePort
}

func startPortForward(cfg *rest.Config, namespace, podName string, remotePort int) (func(), string, error) {
	transport, upgrader, err := spdy.RoundTripperFor(cfg)
	if err != nil {
		return nil, "", err
	}

	hostURL, err := url.Parse(cfg.Host)
	if err != nil {
		return nil, "", err
	}
	hostURL.Path = fmt.Sprintf("/api/v1/namespaces/%s/pods/%s/portforward", namespace, podName)

	stopCh := make(chan struct{}, 1)
	readyCh := make(chan struct{})
	errCh := make(chan error, 1)
	outBuf := bytes.NewBuffer(nil)
	errBuf := bytes.NewBuffer(nil)

	dialer := spdy.NewDialer(upgrader, &http.Client{Transport: transport}, http.MethodPost, hostURL)
	forwarder, err := portforward.NewOnAddresses(dialer, []string{"127.0.0.1"}, []string{fmt.Sprintf("0:%d", remotePort)}, stopCh, readyCh, outBuf, errBuf)
	if err != nil {
		return nil, "", err
	}

	go func() {
		if forwardErr := forwarder.ForwardPorts(); forwardErr != nil {
			errCh <- forwardErr
			return
		}
		errCh <- nil
	}()

	select {
	case <-readyCh:
	case forwardErr := <-errCh:
		if forwardErr == nil {
			forwardErr = fmt.Errorf("port-forward terminated unexpectedly")
		}
		return nil, "", fmt.Errorf("%w (%s)", forwardErr, strings.TrimSpace(errBuf.String()))
	case <-time.After(15 * time.Second):
		close(stopCh)
		return nil, "", fmt.Errorf("timed out waiting for port-forward readiness")
	}

	ports, err := forwarder.GetPorts()
	if err != nil {
		close(stopCh)
		return nil, "", err
	}
	if len(ports) == 0 {
		close(stopCh)
		return nil, "", fmt.Errorf("port-forward did not expose any local ports")
	}

	stop := func() {
		select {
		case <-stopCh:
		default:
			close(stopCh)
		}
		select {
		case <-errCh:
		case <-time.After(2 * time.Second):
		}
	}

	return stop, fmt.Sprintf("127.0.0.1:%d", ports[0].Local), nil
}

func writeTLSMaterial(ctx context.Context, clientset kubernetes.Interface, namespace string) (string, string, string, string, error) {
	secretName := envOrDefault("GOLDMANE_TLS_SECRET", defaultTLSSecret)
	configMapName := envOrDefault("GOLDMANE_CA_CONFIGMAP", defaultCAConfigMap)

	secret, err := clientset.CoreV1().Secrets(namespace).Get(ctx, secretName, metav1.GetOptions{})
	if err != nil {
		return "", "", "", "", err
	}
	configMap, err := clientset.CoreV1().ConfigMaps(namespace).Get(ctx, configMapName, metav1.GetOptions{})
	if err != nil {
		return "", "", "", "", err
	}

	certBytes := secret.Data["tls.crt"]
	keyBytes := secret.Data["tls.key"]
	caBytes := []byte(configMap.Data["ca.crt"])
	if len(certBytes) == 0 || len(keyBytes) == 0 || len(caBytes) == 0 {
		return "", "", "", "", fmt.Errorf("TLS material is incomplete in %s/%s or %s/%s", namespace, secretName, namespace, configMapName)
	}

	tempDir, err := os.MkdirTemp("", "calico-ui-kubeconfig-*")
	if err != nil {
		return "", "", "", "", err
	}

	certFile := filepath.Join(tempDir, "tls.crt")
	keyFile := filepath.Join(tempDir, "tls.key")
	caFile := filepath.Join(tempDir, "ca.crt")

	if err := os.WriteFile(certFile, certBytes, 0o600); err != nil {
		_ = os.RemoveAll(tempDir)
		return "", "", "", "", err
	}
	if err := os.WriteFile(keyFile, keyBytes, 0o600); err != nil {
		_ = os.RemoveAll(tempDir)
		return "", "", "", "", err
	}
	if err := os.WriteFile(caFile, caBytes, 0o600); err != nil {
		_ = os.RemoveAll(tempDir)
		return "", "", "", "", err
	}

	return tempDir, certFile, keyFile, caFile, nil
}
