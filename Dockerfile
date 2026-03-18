FROM node:20-bookworm-slim AS frontend-build

WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build


FROM golang:1.22-bookworm AS backend-build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download

COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY proto/ ./proto/
COPY --from=frontend-build /src/frontend/dist ./cmd/server/dist

RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" -o /out/calico-ui ./cmd/server


FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -S calico-ui && \
    adduser -S -G calico-ui -u 10001 calico-ui

COPY --from=backend-build /out/calico-ui /usr/local/bin/calico-ui

ENV KUBECONFIG=/config/kubeconfig \
    GOLDMANE_NAMESPACE=calico-system \
    GOLDMANE_SERVICE_NAME=goldmane \
    GOLDMANE_PORT=7443 \
    GOLDMANE_TLS_SECRET=whisker-backend-key-pair \
    GOLDMANE_CA_CONFIGMAP=whisker-ca-bundle

USER calico-ui
EXPOSE 8080
ENTRYPOINT ["calico-ui"]
