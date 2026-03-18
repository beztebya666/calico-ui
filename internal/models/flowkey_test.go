package models

import "testing"

func TestFlowFingerprintIncludesReporter(t *testing.T) {
	base := Flow{
		ID:        42,
		StartTime: 100,
		EndTime:   101,
		Source: Endpoint{
			Name:      "ingress",
			Namespace: "ingress-nginx",
			Kind:      "wep",
		},
		Destination: Endpoint{
			Name:      "whisker",
			Namespace: "calico-system",
			Kind:      "wep",
			Port:      8081,
		},
		Protocol: "TCP",
		Action:   "Allow",
		Reporter: "src",
	}

	left := FlowFingerprint(base)
	base.Reporter = "dst"
	right := FlowFingerprint(base)

	if left == right {
		t.Fatalf("expected different fingerprints for different reporters")
	}
}

func TestFlowFingerprintIncludesDestinationPort(t *testing.T) {
	base := Flow{
		ID:        42,
		StartTime: 100,
		EndTime:   101,
		Source: Endpoint{
			Name:      "ingress",
			Namespace: "ingress-nginx",
			Kind:      "wep",
		},
		Destination: Endpoint{
			Name:      "whisker",
			Namespace: "calico-system",
			Kind:      "wep",
			Port:      8081,
		},
		Protocol: "TCP",
		Action:   "Allow",
		Reporter: "src",
	}

	left := FlowFingerprint(base)
	base.Destination.Port = 7443
	right := FlowFingerprint(base)

	if left == right {
		t.Fatalf("expected different fingerprints for different ports")
	}
}
