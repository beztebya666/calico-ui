IMAGE ?= calico-ui
TAG   ?= latest

.PHONY: all generate frontend backend docker deploy port-forward clean

all: docker

## -- Proto generation (requires protoc + plugins on host) --
generate:
	protoc --go_out=. --go_opt=paths=source_relative \
	       --go-grpc_out=. --go-grpc_opt=paths=source_relative \
	       proto/api.proto

## -- Frontend --
frontend:
	cd frontend && npm install && npm run build

## -- Backend (requires generate + frontend first) --
backend: generate frontend
	mkdir -p cmd/server/dist
	cp -r frontend/dist/* cmd/server/dist/
	CGO_ENABLED=0 go build -ldflags="-s -w" -o bin/calico-ui ./cmd/server

## -- Docker build (works with Docker 1.13+) --
docker:
	bash build.sh $(IMAGE) $(TAG)

## -- Deploy to Kubernetes --
deploy:
	kubectl apply -f deploy/serviceaccount.yaml
	kubectl apply -f deploy/rbac.yaml
	kubectl apply -f deploy/deployment.yaml
	kubectl apply -f deploy/service.yaml

## -- Port-forward for local access --
port-forward:
	kubectl port-forward -n calico-system svc/calico-ui 8080:8080

## -- Clean --
clean:
	rm -rf bin/ cmd/server/dist/ frontend/dist/ frontend/node_modules/ proto/*.pb.go calico-ui
