package api

import (
	"net/http/httptest"
	"testing"

	"calico-ui/internal/models"
)

func TestParseQueryOptionsClampsShortWindow(t *testing.T) {
	request := httptest.NewRequest("GET", "/api/v1/flows?seconds=5&depth=9&page=0&pageSize=900", nil)

	opts := parseQueryOptions(request)

	if opts.seconds != 15 {
		t.Fatalf("expected seconds to clamp to 15, got %d", opts.seconds)
	}
	if opts.depth != 4 {
		t.Fatalf("expected depth to clamp to 4, got %d", opts.depth)
	}
	if opts.page != 1 {
		t.Fatalf("expected page to default to 1, got %d", opts.page)
	}
	if opts.pageSize != 500 {
		t.Fatalf("expected pageSize to clamp to 500, got %d", opts.pageSize)
	}
}

func TestComputeRouteDepthUsesFurthestEndpoint(t *testing.T) {
	flow := models.Flow{
		Source: models.Endpoint{
			Name:      "whisker-abc",
			Namespace: "calico-system",
			Kind:      "wep",
		},
		Destination: models.Endpoint{
			Name:      "goldmane-def",
			Namespace: "calico-system",
			Kind:      "wep",
		},
	}

	nodeDepths := map[string]int{
		"wep:calico-system/whisker-abc":  1,
		"wep:calico-system/goldmane-def": 2,
	}

	depth := computeRouteDepth(flow, nodeDepths)
	if depth != 2 {
		t.Fatalf("expected furthest endpoint depth to be 2, got %d", depth)
	}
}
