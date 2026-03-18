import React, { useEffect, useState, useCallback, useRef, Component, ErrorInfo, ReactNode } from 'react';
import { HelpCircle, X, AlertTriangle, RefreshCw } from 'lucide-react';
import * as api from './api/client';
import { Header } from './components/Layout/Header';
import { ServiceMap } from './components/ServiceMap/ServiceMap';
import { FlowTable } from './components/FlowTable/FlowTable';
import { ALL_NAMESPACES, useFlowStore } from './stores/flowStore';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class AppErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Calico UI] Uncaught error:', error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: '16px', color: 'var(--text-primary, #e0e0e0)', background: 'var(--bg-primary, #1a1a2e)' }}>
        <AlertTriangle size={48} color="var(--accent-deny, #ef4444)" />
        <h2 style={{ margin: 0, fontSize: '1.25rem' }}>Something went wrong</h2>
        <pre style={{ maxWidth: '600px', overflow: 'auto', padding: '12px', borderRadius: '8px', background: 'var(--bg-tertiary, #2a2a4a)', fontSize: '0.8rem', whiteSpace: 'pre-wrap' }}>
          {this.state.error?.message}
        </pre>
        <button
          onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 20px', borderRadius: '6px', border: 'none', background: 'var(--accent-primary, #6366f1)', color: '#fff', cursor: 'pointer', fontSize: '0.9rem' }}
        >
          <RefreshCw size={14} /> Reload
        </button>
      </div>
    );
  }
}

interface AuthState {
  checking: boolean;
  enabled: boolean;
  authenticated: boolean;
  username?: string;
}

interface RuntimeState {
  checking: boolean;
  ready: boolean;
  mode: string;
  message: string;
  goldmaneAddress?: string;
  serverName?: string;
  kubeconfigPath?: string;
  inCluster: boolean;
  requiresRestart?: boolean;
  instructions: string[];
  connectionSource?: string;
}

export const App: React.FC = () => {
  const {
    viewMode,
    fetchNamespaces,
    refreshData,
    connectStream,
    disconnectStream,
    clearData,
    selectedNamespace,
    setNamespace,
  } = useFlowStore();
  const [splitRatio, setSplitRatio] = useState(0.55);
  const [helpOpen, setHelpOpen] = useState(false);
  const [authState, setAuthState] = useState<AuthState>({
    checking: true,
    enabled: false,
    authenticated: true,
  });
  const [runtimeState, setRuntimeState] = useState<RuntimeState>({
    checking: true,
    ready: true,
    mode: '',
    message: '',
    inCluster: false,
    instructions: [],
  });
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const dragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const bootstrapped = useRef(false);

  const bootstrapAuthenticatedApp = useCallback(async () => {
    const runtime = await api.fetchRuntimeStatus();
    setRuntimeState({
      checking: false,
      ready: runtime.ready,
      mode: runtime.mode,
      message: runtime.message,
      goldmaneAddress: runtime.goldmaneAddress,
      serverName: runtime.serverName,
      kubeconfigPath: runtime.kubeconfigPath,
      inCluster: runtime.inCluster,
      requiresRestart: runtime.requiresRestart,
      instructions: runtime.instructions ?? [],
      connectionSource: runtime.connectionSource,
    });

    if (!runtime.ready) {
      disconnectStream();
      clearData();
      return;
    }

    await fetchNamespaces();
    await refreshData();
    connectStream();
  }, [clearData, connectStream, disconnectStream, fetchNamespaces, refreshData]);

  const syncAuthState = useCallback(async (expiredMessage?: string) => {
    try {
      const [status, runtime] = await Promise.all([
        api.fetchAuthStatus(),
        api.fetchRuntimeStatus(),
      ]);
      setAuthState({
        checking: false,
        enabled: status.enabled,
        authenticated: status.authenticated,
        username: status.username,
      });
      setRuntimeState({
        checking: false,
        ready: runtime.ready,
        mode: runtime.mode,
        message: runtime.message,
        goldmaneAddress: runtime.goldmaneAddress,
        serverName: runtime.serverName,
        kubeconfigPath: runtime.kubeconfigPath,
        inCluster: runtime.inCluster,
        requiresRestart: runtime.requiresRestart,
        instructions: runtime.instructions ?? [],
        connectionSource: runtime.connectionSource,
      });

      if (status.enabled && !status.authenticated) {
        disconnectStream();
        clearData();
        setLoginError(expiredMessage ?? null);
        setLoginForm((current) => ({
          username: current.username || '',
          password: '',
        }));
        return;
      }

      setLoginError(null);
      if (!runtime.ready) {
        disconnectStream();
        clearData();
        return;
      }
      if (
        status.enabled &&
        status.authenticated &&
        selectedNamespace === ALL_NAMESPACES &&
        status.allowedNamespaces &&
        status.allowedNamespaces.length > 0
      ) {
        await fetchNamespaces();
        setNamespace(status.allowedNamespaces[0]);
        return;
      }
      await bootstrapAuthenticatedApp();
    } catch (error) {
      setAuthState((current) => ({
        ...current,
        checking: false,
        enabled: false,
        authenticated: true,
      }));
      setRuntimeState((current) => ({ ...current, checking: false }));
      setLoginError(error instanceof Error ? error.message : 'Failed to initialize authentication');
    }
  }, [bootstrapAuthenticatedApp, clearData, disconnectStream, fetchNamespaces, selectedNamespace, setNamespace]);

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    void syncAuthState();
  }, [syncAuthState]);

  useEffect(() => {
    const handleAuthRequired = () => {
      void syncAuthState('Session expired. Sign in again.');
    };

    window.addEventListener('calico-ui:auth-required', handleAuthRequired);
    return () => {
      window.removeEventListener('calico-ui:auth-required', handleAuthRequired);
    };
  }, [syncAuthState]);

  const onMouseDown = useCallback(() => {
    dragging.current = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const ratio = (e.clientY - rect.top) / rect.height;
      setSplitRatio(Math.max(0.15, Math.min(0.85, ratio)));
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const handleLogin = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoginBusy(true);
    setLoginError(null);

    try {
      const status = await api.login(loginForm.username.trim(), loginForm.password);
      setAuthState({
        checking: false,
        enabled: status.enabled,
        authenticated: status.authenticated,
        username: status.username,
      });
      setLoginForm((current) => ({ ...current, password: '' }));
      await bootstrapAuthenticatedApp();
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Authentication failed');
    } finally {
      setLoginBusy(false);
    }
  }, [bootstrapAuthenticatedApp, loginForm.password, loginForm.username]);

  const handleLogout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      disconnectStream();
      clearData();
      setAuthState((current) => ({
        ...current,
        authenticated: false,
        username: undefined,
      }));
      setLoginForm((current) => ({ ...current, password: '' }));
      setLoginError(null);
    }
  }, [clearData, disconnectStream]);

  const authRequired = authState.enabled && !authState.authenticated;
  const runtimeSetupRequired = !runtimeState.checking && !runtimeState.ready;

  return (
    <div className="app">
      <Header
        onOpenHelp={() => setHelpOpen(true)}
        authEnabled={authState.enabled}
        username={authState.username}
        onLogout={handleLogout}
        runtimeMode={runtimeState.ready ? runtimeState.mode : undefined}
        runtimeSource={runtimeState.connectionSource}
      />
      <div className="main-content" ref={containerRef}>
        {viewMode === 'table' ? (
          <div className="flow-panel" style={{ flex: 1 }}>
            <FlowTable />
          </div>
        ) : viewMode === 'map' ? (
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            <ServiceMap />
          </div>
        ) : (
          <>
            <div style={{ height: `${splitRatio * 100}%`, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              <ServiceMap />
            </div>
            <div className="resize-handle" onMouseDown={onMouseDown}>
              <div className="resize-handle__grip" />
            </div>
            <div className="flow-panel" style={{ flex: 1, minHeight: 0 }}>
              <FlowTable />
            </div>
          </>
        )}
      </div>

      {(authState.checking || runtimeState.checking) && (
        <div className="auth-modal">
          <div className="auth-modal__backdrop" />
          <div className="auth-modal__panel auth-modal__panel--compact fade-in">
            <div className="auth-modal__title">Checking session...</div>
            <div className="auth-modal__subtitle">Calico UI is verifying access to the API and cluster runtime.</div>
          </div>
        </div>
      )}

      {runtimeSetupRequired && !authState.checking && !runtimeState.checking && (
        <div className="auth-modal">
          <div className="auth-modal__backdrop" />
          <div className="auth-modal__panel auth-modal__panel--setup fade-in">
            <div className="auth-modal__header">
              <div>
                <div className="auth-modal__title">Cluster setup required</div>
                <div className="auth-modal__subtitle">
                  Calico UI is running, but this container is not connected to a Kubernetes cluster yet.
                </div>
              </div>
            </div>

            <div className="auth-modal__body">
              <div className="auth-modal__field">
                <span>Runtime mode</span>
                <input value={runtimeState.mode || 'unconfigured'} disabled />
              </div>
              <div className="auth-modal__field">
                <span>Status</span>
                <input value={runtimeState.message} disabled />
              </div>
              {runtimeState.connectionSource ? (
                <div className="auth-modal__field">
                  <span>Connection source</span>
                  <input value={runtimeState.connectionSource} disabled />
                </div>
              ) : null}
              {runtimeState.kubeconfigPath ? (
                <div className="auth-modal__field">
                  <span>Kubeconfig path</span>
                  <input value={runtimeState.kubeconfigPath} disabled />
                </div>
              ) : null}
              {runtimeState.goldmaneAddress ? (
                <div className="auth-modal__field">
                  <span>Goldmane address</span>
                  <input value={runtimeState.goldmaneAddress} disabled />
                </div>
              ) : null}

              <div className="auth-modal__instructions">
                <div className="auth-modal__instructions-title">How to run this container</div>
                <ul className="auth-modal__instructions-list">
                  {runtimeState.instructions.map((instruction) => (
                    <li key={instruction}>{instruction}</li>
                  ))}
                </ul>
              </div>

              <div className="auth-modal__hint">
                Kubernetes mode: no kubeconfig is needed in the browser. Docker mode: mount kubeconfig into the container and restart it.
              </div>
            </div>
          </div>
        </div>
      )}

      {authRequired && !authState.checking && !runtimeSetupRequired && (
        <div className="auth-modal">
          <div className="auth-modal__backdrop" />
          <form className="auth-modal__panel fade-in" onSubmit={handleLogin}>
            <div className="auth-modal__header">
              <div>
                <div className="auth-modal__title">Sign in</div>
                <div className="auth-modal__subtitle">
                  Authenticated access is required before flows and graphs can be loaded. Cluster connection is configured on the server side, not in the browser.
                </div>
              </div>
            </div>

            <div className="auth-modal__body">
              <label className="auth-modal__field">
                <span>Username</span>
                <input
                  value={loginForm.username}
                  onChange={(event) => setLoginForm((current) => ({ ...current, username: event.target.value }))}
                  autoComplete="username"
                  autoFocus
                />
              </label>

              <label className="auth-modal__field">
                <span>Password</span>
                <input
                  type="password"
                  value={loginForm.password}
                  onChange={(event) => setLoginForm((current) => ({ ...current, password: event.target.value }))}
                  autoComplete="current-password"
                />
              </label>

              {loginError ? <div className="auth-modal__error">{loginError}</div> : null}
            </div>

            <div className="auth-modal__footer">
              <button className="auth-modal__submit" disabled={loginBusy}>
                {loginBusy ? 'Signing in...' : 'Sign in'}
              </button>
            </div>
          </form>
        </div>
      )}

      {helpOpen && (
        <div className="help-modal">
          <div className="help-modal__backdrop" onClick={() => setHelpOpen(false)} />
          <div className="help-modal__panel fade-in">
            <div className="help-modal__header">
              <div className="help-modal__title">
                <HelpCircle size={18} />
                How to use the map
              </div>
              <button className="help-modal__close" onClick={() => setHelpOpen(false)}>
                <X size={16} />
              </button>
            </div>

            <div className="help-modal__content">
              <div className="help-modal__section">
                <h3>Modes</h3>
                <p><strong>All Namespaces</strong> shows namespace-to-namespace traffic, not every service at once.</p>
                <p><strong>Namespace Services</strong> shows services and endpoints inside the selected namespace.</p>
                <p><strong>Route View</strong> expands the neighborhood around the selected node without hiding the rest of the visible route.</p>
              </div>

              <div className="help-modal__section">
                <h3>Runtime setup</h3>
                <p><strong>In-cluster</strong> means the container runs inside Kubernetes and uses the pod service account plus mounted TLS material. No kubeconfig is needed in the browser.</p>
                <p><strong>Kubeconfig</strong> means the container runs outside Kubernetes and was started with a mounted kubeconfig. The backend uses it to create a secure tunnel to Goldmane.</p>
                <p><strong>Direct</strong> means the container was started with an explicit <code>GOLDMANE_ADDRESS</code> and TLS files. This is an advanced deployment mode.</p>
              </div>

              <div className="help-modal__section">
                <h3>Controls</h3>
                <p><strong>Cross-NS</strong> keeps only traffic that crosses namespace boundaries.</p>
                <p><strong>Depth</strong> controls how many hops away from the selected node Route View expands.</p>
                <p><strong>Window</strong> sets how much recent data the graph and table should inspect. A larger window makes intermittent denies easier to catch.</p>
                <p><strong>Search</strong> jumps to a namespace, service, or endpoint already present in the current graph.</p>
                <p><strong>Hide context</strong> collapses the panel in the top-left corner if you need more room for the map.</p>
              </div>

              <div className="help-modal__section">
                <h3>Flow diagnostics</h3>
                <p><strong>Reporter</strong> tells you where the decision was observed. <code>Source</code> means the source side of the flow, <code>Destination</code> means the destination side.</p>
                <p>The same traffic can appear as <strong>Allow</strong> on the source side and <strong>Deny</strong> on the destination side when egress is allowed but ingress is blocked.</p>
                <p><strong>Policy Trace</strong> shows the best policy information Goldmane attached to the flow. If you see <code>No named policy trace</code>, the deny is real but Goldmane did not attach a named policy hit.</p>
                <p><strong>Sorting</strong> is available directly from the table headers. Click a column again to reverse the order.</p>
                <p><strong>Route View table</strong> groups flows by route depth so you can see what was added at depth 1, depth 2, depth 3, and so on without losing the full route context.</p>
                <p>Click any row in the flow table to inspect the full trace, reporter, counters, and enforced or pending policy hits.</p>
              </div>

              <div className="help-modal__section">
                <h3>Labels</h3>
                <p>The large label is the best human-readable name we have. If Goldmane reports a Kubernetes Service name, it is used first.</p>
                <p>The smaller label explains the scope: namespace, service namespace, external network, host endpoint, or another endpoint type.</p>
                <p>Raw identifiers such as <code>pvt</code> can still appear when Goldmane only exposes a low-level endpoint name and no better service metadata exists. In that case the tooltip shows the raw endpoint name explicitly.</p>
              </div>

              <div className="help-modal__section">
                <h3>Why some names looked like "-"</h3>
                <p>A dash usually means Goldmane returned a placeholder instead of a real service name. The UI now strips that placeholder and falls back to the raw endpoint name or a descriptive label.</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
