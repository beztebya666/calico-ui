# Calico UI   

![image](/docs/screenshots/main_screen.png)   

Calico UI is a web UI for exploring Goldmane network flow data from Calico clusters.   

dockerhub: https://hub.docker.com/r/beztebya666/calico-ui   

It supports two runtime modes:

- `in-cluster`: the container runs inside Kubernetes and connects to Goldmane using cluster DNS and mounted TLS material.
- `external-kubeconfig`: the container runs anywhere Docker can run, and bootstraps a secure tunnel to Goldmane from a mounted kubeconfig.

## Run In Kubernetes

Use the bundled manifests:

```bash
bash build.sh
kubectl apply -f deploy/
kubectl delete pod -l app=calico-ui -n calico-system
```

In this mode, no kubeconfig is needed in the browser or in the login form. The backend uses the in-cluster service account and mounted Whisker TLS material.

## Run In Docker Outside Kubernetes

Mount a kubeconfig into the container. The backend will:

1. open a Kubernetes API connection from the mounted kubeconfig
2. resolve the `goldmane` service and backing pod
3. create a local port-forward
4. fetch the TLS secret/configmap from the cluster
5. connect to Goldmane over mTLS

Example:

```bash
docker run --rm -p 8080:8080 \
  -v $HOME/.kube/config:/config/kubeconfig:ro \
  -e AUTH_USERNAME=admin \
  -e AUTH_PASSWORD=change-me \
  ghcr.io/your-org/calico-ui:latest
```

Open:

```text
http://localhost:8080/calico-ui/
```

## Advanced Direct Mode

If you expose Goldmane directly, you can bypass kubeconfig bootstrap:

```bash
docker run --rm -p 8080:8080 \
  -e GOLDMANE_ADDRESS=goldmane.example.com:7443 \
  -e TLS_CERT_PATH=/certs/tls.crt \
  -e TLS_KEY_PATH=/certs/tls.key \
  -e TLS_CA_PATH=/certs/ca.crt \
  -e GOLDMANE_TLS_SERVER_NAME=goldmane.calico-system.svc.cluster.local \
  -v $(pwd)/certs:/certs:ro \
  ghcr.io/your-org/calico-ui:latest
```

## Default Runtime Environment

The published image expects these defaults unless overridden:

- `KUBECONFIG=/config/kubeconfig`
- `GOLDMANE_NAMESPACE=calico-system`
- `GOLDMANE_SERVICE_NAME=goldmane`
- `GOLDMANE_PORT=7443`
- `GOLDMANE_TLS_SECRET=whisker-backend-key-pair`
- `GOLDMANE_CA_CONFIGMAP=whisker-ca-bundle`

## Authentication

Authentication protects the UI itself. Cluster connection is configured on the server side, not in the browser.

For local testing:

```bash
-e AUTH_USERNAME=admin
-e AUTH_PASSWORD=change-me
```
