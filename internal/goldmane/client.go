package goldmane

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	pb "calico-ui/proto"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
)

// Client wraps the Goldmane gRPC connection.
type Client struct {
	conn   *grpc.ClientConn
	flows  pb.FlowsClient
	stats  pb.StatisticsClient
	logger *slog.Logger
}

func NewClient(addr, certFile, keyFile, caFile string, logger *slog.Logger) (*Client, error) {
	return NewClientWithServerName(addr, certFile, keyFile, caFile, "", logger)
}

func NewClientWithServerName(addr, certFile, keyFile, caFile, serverName string, logger *slog.Logger) (*Client, error) {
	var opts []grpc.DialOption

	if certFile == "" && keyFile == "" && caFile == "" {
		opts = append(opts, grpc.WithTransportCredentials(insecure.NewCredentials()))
	} else {
		tlsCfg := &tls.Config{
			MinVersion: tls.VersionTLS12,
		}
		if strings.TrimSpace(serverName) != "" {
			tlsCfg.ServerName = strings.TrimSpace(serverName)
		}

		if (certFile == "") != (keyFile == "") {
			return nil, fmt.Errorf("tls client cert and key must be configured together")
		}

		if certFile != "" && keyFile != "" {
			cert, err := tls.LoadX509KeyPair(certFile, keyFile)
			if err != nil {
				return nil, fmt.Errorf("load client cert: %w", err)
			}
			tlsCfg.Certificates = []tls.Certificate{cert}
		}

		if caFile != "" {
			caCert, err := os.ReadFile(caFile)
			if err != nil {
				return nil, fmt.Errorf("read CA cert: %w", err)
			}
			pool := x509.NewCertPool()
			pool.AppendCertsFromPEM(caCert)
			tlsCfg.RootCAs = pool
		}

		opts = append(opts, grpc.WithTransportCredentials(credentials.NewTLS(tlsCfg)))
	}

	conn, err := grpc.NewClient(addr, opts...)
	if err != nil {
		return nil, fmt.Errorf("grpc dial %s: %w", addr, err)
	}

	logger.Info("connected to goldmane", "addr", addr)

	return &Client{
		conn:   conn,
		flows:  pb.NewFlowsClient(conn),
		stats:  pb.NewStatisticsClient(conn),
		logger: logger,
	}, nil
}

func (c *Client) Close() error {
	return c.conn.Close()
}

// ListFlows returns a page of aggregated flows.
func (c *Client) ListFlows(ctx context.Context, req *pb.FlowListRequest) (*pb.FlowListResult, error) {
	return c.flows.List(ctx, req)
}

// StreamFlows opens a streaming connection for real-time flow data.
func (c *Client) StreamFlows(ctx context.Context, req *pb.FlowStreamRequest) (pb.Flows_StreamClient, error) {
	return c.flows.Stream(ctx, req)
}

// FilterHints returns available filter values (namespaces, names, etc).
func (c *Client) FilterHints(ctx context.Context, req *pb.FilterHintsRequest) (*pb.FilterHintsResult, error) {
	return c.flows.FilterHints(ctx, req)
}

// GetNamespaces returns all source namespaces visible in the last hour.
func (c *Client) GetNamespaces(ctx context.Context) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	sourceHints, err := c.flows.FilterHints(ctx, &pb.FilterHintsRequest{
		Type:         pb.FilterType_FilterTypeSourceNamespace,
		StartTimeGte: -3600,
		PageSize:     1000,
	})
	if err != nil {
		return nil, err
	}

	destHints, err := c.flows.FilterHints(ctx, &pb.FilterHintsRequest{
		Type:         pb.FilterType_FilterTypeDestNamespace,
		StartTimeGte: -3600,
		PageSize:     1000,
	})
	if err != nil {
		return nil, err
	}

	seen := map[string]bool{}
	out := make([]string, 0, len(sourceHints.Hints)+len(destHints.Hints))
	for _, set := range [][]*pb.FilterHint{sourceHints.Hints, destHints.Hints} {
		for _, hint := range set {
			if hint.Value == "" || seen[hint.Value] {
				continue
			}
			seen[hint.Value] = true
			out = append(out, hint.Value)
		}
	}

	return out, nil
}

func (c *Client) Ping(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	_, err := c.flows.FilterHints(ctx, &pb.FilterHintsRequest{
		Type:         pb.FilterType_FilterTypeSourceNamespace,
		StartTimeGte: -60,
		PageSize:     1,
	})
	return err
}
