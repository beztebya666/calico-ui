import React, { useState, useRef, useEffect } from 'react';
import { Network, ChevronDown, HelpCircle, Columns3, Map, Table2 } from 'lucide-react';
import { useFlowStore, ViewMode, ALL_NAMESPACES, TIME_WINDOW_OPTIONS } from '../../stores/flowStore';
import { formatNamespaceLabel } from '../../utils/namespace';

interface HeaderProps {
  onOpenHelp: () => void;
  authEnabled: boolean;
  username?: string;
  onLogout: () => void;
  runtimeMode?: string;
  runtimeSource?: string;
}

export const Header: React.FC<HeaderProps> = ({ onOpenHelp, authEnabled, username, onLogout, runtimeMode, runtimeSource }) => {
  const {
    namespaces, selectedNamespace, setNamespace,
    viewMode, setViewMode, isConnected, timeWindowSeconds, setTimeWindow,
  } = useFlowStore();

  const [nsOpen, setNsOpen] = useState(false);
  const [nsSearch, setNsSearch] = useState('');
  const [windowOpen, setWindowOpen] = useState(false);
  const nsRef = useRef<HTMLDivElement>(null);
  const windowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (nsRef.current && !nsRef.current.contains(e.target as Node)) setNsOpen(false);
      if (windowRef.current && !windowRef.current.contains(e.target as Node)) setWindowOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = namespaces.filter((n) =>
    n.toLowerCase().includes(nsSearch.toLowerCase()),
  );
  const selectedLabel = formatNamespaceLabel(selectedNamespace);
  const selectedWindow = TIME_WINDOW_OPTIONS.find((option) => option.seconds === timeWindowSeconds) ?? TIME_WINDOW_OPTIONS[1];
  const describeWindow = (seconds: number) => {
    switch (seconds) {
      case 15:
        return 'Latest 15 seconds';
      case 30:
        return 'Latest 30 seconds';
      case 60:
        return 'Latest 1 minute';
      case 300:
        return 'Latest 5 minutes';
      case 600:
        return 'Latest 10 minutes';
      case 900:
        return 'Latest 15 minutes';
      case 1800:
        return 'Latest 30 minutes';
      case 3600:
        return 'Latest 1 hour';
      default:
        return `Latest ${seconds} seconds`;
    }
  };

  const views: { mode: ViewMode; icon: React.ReactNode; label: string }[] = [
    { mode: 'split', icon: <Columns3 size={14} />, label: 'Split' },
    { mode: 'map', icon: <Map size={14} />, label: 'Map' },
    { mode: 'table', icon: <Table2 size={14} />, label: 'Table' },
  ];

  return (
    <header className="header">
      <div className="header__logo">
        <Network size={20} />
        <div className="header__logo-text">
          Calico UI <span>Network Observer</span>
        </div>
      </div>

      <div className="header__divider" />

      <div className="header__ns-select" ref={nsRef}>
        <button className="header__ns-btn" onClick={() => setNsOpen(!nsOpen)}>
          <span className="label">Namespace:</span>
          {selectedLabel}
          <ChevronDown size={14} />
        </button>
        {nsOpen && (
          <div className="header__ns-dropdown fade-in">
            <div className="header__ns-search">
              <input
                placeholder="Search namespaces..."
                value={nsSearch}
                onChange={(e) => setNsSearch(e.target.value)}
                autoFocus
              />
            </div>
            <div className="header__ns-list">
              <div
                className={`header__ns-item ${selectedNamespace === ALL_NAMESPACES ? 'header__ns-item--active' : ''}`}
                onClick={() => { setNamespace(ALL_NAMESPACES); setNsOpen(false); setNsSearch(''); }}
              >
                All Namespaces
              </div>
              {filtered.map((ns) => (
                <div
                  key={ns}
                  className={`header__ns-item ${ns === selectedNamespace ? 'header__ns-item--active' : ''}`}
                  onClick={() => { setNamespace(ns); setNsOpen(false); setNsSearch(''); }}
                >
                  {formatNamespaceLabel(ns)}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="header__ns-select" ref={windowRef}>
        <button className="header__ns-btn" onClick={() => setWindowOpen(!windowOpen)}>
          <span className="label">Window:</span>
          {selectedWindow.label}
          <ChevronDown size={14} />
        </button>
        {windowOpen && (
          <div className="header__window-dropdown fade-in">
            <div className="header__window-caption">Observed time window</div>
            <div className="header__window-list">
              {TIME_WINDOW_OPTIONS.map((option) => (
                <button
                  key={option.seconds}
                  className={`header__window-item ${option.seconds === timeWindowSeconds ? 'header__window-item--active' : ''}`}
                  onClick={() => {
                    setTimeWindow(option.seconds);
                    setWindowOpen(false);
                  }}
                >
                  <span>{option.label}</span>
                  <span className="hint">{describeWindow(option.seconds)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="header__spacer" />

      <div className="header__view-toggle">
        {views.map((v) => (
          <button
            key={v.mode}
            className={`header__view-btn ${viewMode === v.mode ? 'header__view-btn--active' : ''}`}
            onClick={() => setViewMode(v.mode)}
          >
            {v.icon} {v.label}
          </button>
        ))}
      </div>

      <button className="header__icon-btn" onClick={onOpenHelp} title="Open help">
        <HelpCircle size={16} />
      </button>

      {runtimeMode ? (
        <div className="header__runtime" title={runtimeSource || runtimeMode}>
          {runtimeMode === 'in-cluster' ? 'In-cluster' : runtimeMode === 'external-kubeconfig' ? 'Kubeconfig' : runtimeMode === 'direct-goldmane' ? 'Direct' : runtimeMode}
        </div>
      ) : null}

      {authEnabled && username ? (
        <>
          <div className="header__user">
            <span className="header__user-name">{username}</span>
            <button className="header__user-btn" onClick={onLogout}>
              Sign out
            </button>
          </div>
          <div className="header__divider" />
        </>
      ) : null}

      <div className="header__status">
        <div className={`header__status-dot ${isConnected ? '' : 'header__status-dot--disconnected'}`} />
        {isConnected ? 'Live' : 'Disconnected'}
      </div>
    </header>
  );
};
