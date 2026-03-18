#!/bin/bash
set -e

IMAGE="${1:-calico-ui}"
TAG="${2:-latest}"
WORKDIR="$(cd "$(dirname "$0")" && pwd)"
cd "$WORKDIR"

# ── Helpers ──
ensure_go() {
  if command -v go &>/dev/null; then
    echo "    Go: $(go version)"
    return
  fi
  echo "==> Installing Go 1.22.5..."
  curl -fsSL https://go.dev/dl/go1.22.5.linux-amd64.tar.gz | sudo tar -C /usr/local -xz
  export PATH="/usr/local/go/bin:$PATH"
  echo "    Go: $(go version)"
}

ensure_node() {
  # Check node AND npm both work
  if command -v node &>/dev/null && node --version &>/dev/null \
     && command -v npm &>/dev/null && npm --version &>/dev/null; then
    echo "    Node: $(node --version), npm: $(npm --version)"
    return
  fi
  echo "==> Installing Node.js 20 LTS..."
  sudo rm -rf /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx \
              /usr/local/lib/node_modules /usr/local/include/node 2>/dev/null
  curl -fsSL https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.xz \
    | sudo tar -xJ -C /usr/local --strip-components=1
  echo "    Node: $(node --version), npm: $(npm --version)"
}

ensure_protoc() {
  if command -v protoc &>/dev/null; then
    echo "    protoc: $(protoc --version)"
    return
  fi
  echo "==> Installing protoc..."
  local tmp=$(mktemp -d)
  curl -fsSL https://github.com/protocolbuffers/protobuf/releases/download/v27.2/protoc-27.2-linux-x86_64.zip -o "$tmp/protoc.zip"
  cd "$tmp" && unzip -q protoc.zip -d protoc && sudo cp protoc/bin/protoc /usr/local/bin/ && sudo cp -r protoc/include/* /usr/local/include/ 2>/dev/null || true
  cd "$WORKDIR" && rm -rf "$tmp"
  echo "    protoc: $(protoc --version)"
}

ensure_protoc_plugins() {
  export GOPATH="${GOPATH:-$HOME/go}"
  export PATH="$GOPATH/bin:$PATH"
  if ! command -v protoc-gen-go &>/dev/null; then
    echo "==> Installing protoc-gen-go..."
    go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
  fi
  if ! command -v protoc-gen-go-grpc &>/dev/null; then
    echo "==> Installing protoc-gen-go-grpc..."
    go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
  fi
}

# ── Step 1: Ensure tools ──
echo "==> Checking build tools..."
ensure_go
ensure_node
ensure_protoc
ensure_protoc_plugins

# ── Step 2: Generate proto ──
echo "==> Generating proto Go code..."
protoc --go_out=. --go_opt=paths=source_relative \
       --go-grpc_out=. --go-grpc_opt=paths=source_relative \
       proto/api.proto

# ── Step 3: Build frontend ──
echo "==> Building frontend..."
# Copy to local filesystem — shared folders (hgfs) don't support symlinks
BUILDTMP=$(mktemp -d)
cp -r frontend "$BUILDTMP/frontend"
cd "$BUILDTMP/frontend"
npm install --no-audit
npm run build
mkdir -p "$WORKDIR/frontend/dist"
cp -r dist/* "$WORKDIR/frontend/dist/"
cd "$WORKDIR"
rm -rf "$BUILDTMP"

# ── Step 4: Build Go binary ──
echo "==> Building Go binary..."
mkdir -p cmd/server/dist
cp -r frontend/dist/* cmd/server/dist/
go mod tidy
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o calico-ui ./cmd/server
echo "    Binary: $(ls -lh calico-ui | awk '{print $5}')"

# ── Step 5: Create Docker image via 'docker import' (no pull needed) ──
echo "==> Creating Docker image ${IMAGE}:${TAG}..."
ROOTFS=$(mktemp -d)
mkdir -p "$ROOTFS/usr/local/bin" "$ROOTFS/etc/ssl/certs" "$ROOTFS/tmp"

cp calico-ui "$ROOTFS/usr/local/bin/"

# Copy CA certs for TLS
for ca in /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/certs/ca-certificates.crt; do
  [ -f "$ca" ] && cp "$ca" "$ROOTFS/etc/ssl/certs/ca-certificates.crt" && break
done

tar -C "$ROOTFS" -c . | docker import \
  --change 'ENTRYPOINT ["/usr/local/bin/calico-ui"]' \
  --change 'EXPOSE 8080' \
  --change 'ENV KUBECONFIG=/config/kubeconfig' \
  --change 'ENV GOLDMANE_NAMESPACE=calico-system' \
  --change 'ENV GOLDMANE_SERVICE_NAME=goldmane' \
  --change 'ENV GOLDMANE_PORT=7443' \
  --change 'ENV GOLDMANE_TLS_SECRET=whisker-backend-key-pair' \
  --change 'ENV GOLDMANE_CA_CONFIGMAP=whisker-ca-bundle' \
  - "${IMAGE}:${TAG}"

rm -rf "$ROOTFS" calico-ui

echo ""
echo "==> Done! Image: ${IMAGE}:${TAG}"
echo "    Deploy:  kubectl apply -f deploy/"
echo "    In-kube: kubectl apply -f deploy/"
echo "    Docker:  docker run --rm -p 8080:8080 -v \$HOME/.kube/config:/config/kubeconfig:ro ${IMAGE}:${TAG}"
