import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import {
  startTransition,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import "./App.css";

const SNAPSHOT_EVENT = "show-my-token://snapshot";
const windowHandle = getCurrentWindow();
const numberFormatter = new Intl.NumberFormat("en-US");

type AppSettings = {
  appearance: {
    opacity: number;
    fontScale: number;
    textColor: string;
    accentColor: string;
    compactMode: boolean;
  };
  window: {
    alwaysOnTop: boolean;
    position: { x: number; y: number } | null;
  };
};

type CollectorStatus = {
  endpoint: string;
  sourceMode: string;
  status: string;
  connected: boolean;
  message: string;
  error: string | null;
  lastEventUnixMs: number | null;
};

type ProviderSnapshot = {
  id: string;
  label: string;
  agentName: string;
  providerName: string;
  status: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
  recentDeltas: number[];
  lastModel: string | null;
  lastUpdateUnixMs: number | null;
  source: string;
};

type EditorTarget = {
  id: string;
  label: string;
  settingsPath: string;
  exists: boolean;
  connected: boolean;
};

type DashboardSnapshot = {
  settings: AppSettings;
  collector: CollectorStatus;
  providers: ProviderSnapshot[];
  editorTargets: EditorTarget[];
  appVersion: string;
};

function useAnimatedNumber(value: number, duration = 520) {
  const [animatedValue, setAnimatedValue] = useState(value);
  const previousValue = useRef(value);

  useEffect(() => {
    const startValue = previousValue.current;
    const delta = value - startValue;

    if (delta === 0) {
      return;
    }

    let frame = 0;
    const start = performance.now();

    const animate = (now: number) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const nextValue = startValue + delta * eased;

      setAnimatedValue(nextValue);

      if (progress < 1) {
        frame = requestAnimationFrame(animate);
      } else {
        previousValue.current = value;
      }
    };

    frame = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(frame);
      previousValue.current = value;
    };
  }, [duration, value]);

  return Math.round(animatedValue);
}

function formatTokenCount(value: number) {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }

  return numberFormatter.format(value);
}

function formatRelativeTime(unixMs: number | null) {
  if (!unixMs) {
    return "No activity yet";
  }

  const deltaSeconds = Math.max(0, Math.round((Date.now() - unixMs) / 1000));

  if (deltaSeconds < 5) {
    return "Updated just now";
  }

  if (deltaSeconds < 60) {
    return `Updated ${deltaSeconds}s ago`;
  }

  const minutes = Math.round(deltaSeconds / 60);
  return `Updated ${minutes}m ago`;
}

function buildSparklinePath(points: number[]) {
  const series = points.length > 0 ? points.slice(-16) : [0, 0, 0];
  const max = Math.max(...series, 1);

  return series
    .map((point, index) => {
      const x = series.length === 1 ? 100 : (index / (series.length - 1)) * 100;
      const y = 34 - (point / max) * 24;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function Sparkline({ points }: { points: number[] }) {
  return (
    <svg className="sparkline" viewBox="0 0 100 36" preserveAspectRatio="none">
      <path className="sparkline__glow" d={buildSparklinePath(points)} />
      <path className="sparkline__line" d={buildSparklinePath(points)} />
    </svg>
  );
}

function App() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const startupApplied = useRef(false);
  const moveTimer = useRef<number | null>(null);

  const applyWindowPreferences = useEffectEvent(async (settings: AppSettings) => {
    await windowHandle.setAlwaysOnTop(settings.window.alwaysOnTop);

    if (settings.window.position) {
      await windowHandle.setPosition(
        new PhysicalPosition(
          Math.round(settings.window.position.x),
          Math.round(settings.window.position.y),
        ),
      );
    }
  });

  const hydrateSnapshot = useEffectEvent(
    (nextSnapshot: DashboardSnapshot, reason: "boot" | "event" | "save" | "reload") => {
      startTransition(() => {
        setSnapshot(nextSnapshot);

        if (reason !== "event" || !isDirty) {
          setDraft(nextSnapshot.settings);
        }

        if (reason === "save" || reason === "reload") {
          setIsDirty(false);
        }
      });

      if (!startupApplied.current || reason === "save") {
        startupApplied.current = true;
        void applyWindowPreferences(nextSnapshot.settings);
      }
    },
  );

  const reloadSnapshot = useEffectEvent(async (reason: "boot" | "reload") => {
    const nextSnapshot = await invoke<DashboardSnapshot>("bootstrap");
    hydrateSnapshot(nextSnapshot, reason);
  });

  useEffect(() => {
    void reloadSnapshot("boot");

    let unlistenSnapshot: (() => void) | undefined;
    let unlistenMove: (() => void) | undefined;

    void listen<DashboardSnapshot>(SNAPSHOT_EVENT, ({ payload }) => {
      hydrateSnapshot(payload, "event");
    }).then((dispose) => {
      unlistenSnapshot = dispose;
    });

    void windowHandle
      .onMoved(({ payload }) => {
        if (moveTimer.current !== null) {
          window.clearTimeout(moveTimer.current);
        }

        moveTimer.current = window.setTimeout(() => {
          void invoke("save_window_position", { x: payload.x, y: payload.y });
        }, 160);
      })
      .then((dispose) => {
        unlistenMove = dispose;
      });

    return () => {
      unlistenSnapshot?.();
      unlistenMove?.();

      if (moveTimer.current !== null) {
        window.clearTimeout(moveTimer.current);
      }
    };
  }, [hydrateSnapshot, reloadSnapshot]);

  useEffect(() => {
    if (!notice) {
      return;
    }

    const timeout = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  async function saveAppearanceSettings() {
    if (!draft) {
      return;
    }

    setBusyAction("save-settings");

    try {
      const nextSnapshot = await invoke<DashboardSnapshot>("save_settings", {
        settings: draft,
      });
      hydrateSnapshot(nextSnapshot, "save");
      setNotice("Overlay settings saved.");
    } finally {
      setBusyAction(null);
    }
  }

  async function connectEditor(targetId: string, label: string) {
    setBusyAction(targetId);

    try {
      await invoke("connect_editor_target", { targetId });
      await reloadSnapshot("reload");
      setNotice(`${label} is now streaming OTLP into ShowMyToken.`);
    } finally {
      setBusyAction(null);
    }
  }

  async function resetCounters() {
    setBusyAction("reset");

    try {
      const nextSnapshot = await invoke<DashboardSnapshot>("reset_counters");
      hydrateSnapshot(nextSnapshot, "reload");
      setNotice("Token counters reset.");
    } finally {
      setBusyAction(null);
    }
  }

  async function hideOverlay() {
    await windowHandle.minimize();
    setNotice("Overlay minimized. Use the taskbar icon to show it again.");
  }

  async function quitOverlay() {
    await invoke("quit_app");
  }

  function updateDraft(nextDraft: AppSettings) {
    setDraft(nextDraft);
    setIsDirty(true);
  }

  const visibleProviders =
    snapshot?.providers.filter(
      (provider) =>
        provider.totalTokens > 0 || ["copilot", "claude", "copilotcli"].includes(provider.id),
    ) ?? [];
  const totalInput = visibleProviders.reduce((sum, provider) => sum + provider.inputTokens, 0);
  const totalOutput = visibleProviders.reduce((sum, provider) => sum + provider.outputTokens, 0);
  const totalTokens = totalInput + totalOutput;
  const totalRequests = visibleProviders.reduce((sum, provider) => sum + provider.requests, 0);
  const topProvider = visibleProviders[0];
  const animatedTotal = useAnimatedNumber(totalTokens);
  const animatedInput = useAnimatedNumber(totalInput);
  const animatedOutput = useAnimatedNumber(totalOutput);
  const animatedRequests = useAnimatedNumber(totalRequests);
  const panelStyle = {
    "--panel-opacity": String(draft?.appearance.opacity ?? 0.76),
    "--panel-scale": String(draft?.appearance.fontScale ?? 1),
    "--panel-text": draft?.appearance.textColor ?? "#F8FBFF",
    "--panel-accent": draft?.appearance.accentColor ?? "#FF8A3D",
  } as CSSProperties;

  return (
    <main
      className={`shell ${draft?.appearance.compactMode ? "shell--compact" : ""} ${
        settingsOpen ? "shell--expanded" : ""
      }`}
      style={panelStyle}
    >
      <section className="glass-panel">
        <header className="topbar" data-tauri-drag-region>
          <div className="brand-block" data-tauri-drag-region>
            <span className="brand-pill">SHOWMYTOKEN</span>
            <div>
              <p className="eyebrow">Live Agent Overlay</p>
              <h1>Desktop token telemetry, no dashboard tab required.</h1>
            </div>
          </div>

          <div className="topbar__actions">
            <button className="ghost-button" type="button" onClick={() => setSettingsOpen((open) => !open)}>
              {settingsOpen ? "Hide settings" : "Settings"}
            </button>
            <button className="ghost-button" type="button" onClick={hideOverlay}>
              Hide
            </button>
            <button className="ghost-button ghost-button--danger" type="button" onClick={quitOverlay}>
              Quit
            </button>
          </div>
        </header>

        <section className="hero">
          <div className="hero__copy">
            <p className="eyebrow">Total agent tokens</p>
            <div className="hero__value-row">
              <strong>{formatTokenCount(animatedTotal)}</strong>
              <span>{snapshot?.collector.connected ? "LIVE" : "IDLE"}</span>
            </div>
            <p className="status-line">{snapshot?.collector.message ?? "Booting collector..."}</p>
            <p className="status-line status-line--subtle">
              {formatRelativeTime(snapshot?.collector.lastEventUnixMs ?? null)}
            </p>
          </div>

          <div className="hero__spark">
            <Sparkline points={topProvider?.recentDeltas ?? []} />
            <div className="hero__spark-caption">
              <span>{topProvider?.label ?? "GitHub Copilot"}</span>
              <span>{topProvider?.lastModel ?? "waiting for first model"}</span>
            </div>
          </div>
        </section>

        <section className="stats-grid">
          <article className="metric-card">
            <span>Input</span>
            <strong>{formatTokenCount(animatedInput)}</strong>
          </article>
          <article className="metric-card">
            <span>Output</span>
            <strong>{formatTokenCount(animatedOutput)}</strong>
          </article>
          <article className="metric-card">
            <span>Requests</span>
            <strong>{formatTokenCount(animatedRequests)}</strong>
          </article>
          <article className="metric-card metric-card--status">
            <span>Collector</span>
            <strong>{snapshot?.collector.status ?? "starting"}</strong>
            <small>{snapshot?.collector.endpoint ?? "http://127.0.0.1:14318"}</small>
          </article>
        </section>

        <section className="provider-grid">
          {visibleProviders.map((provider) => (
            <article className="provider-card" key={provider.id}>
              <div className="provider-card__header">
                <div>
                  <p>{provider.label}</p>
                  <span>{provider.lastModel ?? provider.providerName}</span>
                </div>
                <span className={`provider-card__dot provider-card__dot--${provider.status}`} />
              </div>

              <div className="provider-card__value">{formatTokenCount(provider.totalTokens)}</div>
              <div className="provider-card__meta">
                <span>{provider.requests} req</span>
                <span>
                  {formatTokenCount(provider.inputTokens)}/{formatTokenCount(provider.outputTokens)}
                </span>
              </div>
              <Sparkline points={provider.recentDeltas} />
            </article>
          ))}
        </section>

        <section className={`settings-drawer ${settingsOpen ? "settings-drawer--open" : ""}`}>
          <div className="settings-group">
            <div>
              <p className="eyebrow">Display controls</p>
              <h2>Overlay tuning</h2>
            </div>

            <label>
              <span>Panel opacity</span>
              <input
                type="range"
                min="0.35"
                max="0.95"
                step="0.01"
                value={draft?.appearance.opacity ?? 0.76}
                onChange={(event) =>
                  draft &&
                  updateDraft({
                    ...draft,
                    appearance: {
                      ...draft.appearance,
                      opacity: Number(event.currentTarget.value),
                    },
                  })
                }
              />
            </label>

            <label>
              <span>Font scale</span>
              <input
                type="range"
                min="0.9"
                max="1.4"
                step="0.01"
                value={draft?.appearance.fontScale ?? 1}
                onChange={(event) =>
                  draft &&
                  updateDraft({
                    ...draft,
                    appearance: {
                      ...draft.appearance,
                      fontScale: Number(event.currentTarget.value),
                    },
                  })
                }
              />
            </label>

            <label className="settings-group__swatch">
              <span>Accent</span>
              <input
                type="color"
                value={draft?.appearance.accentColor ?? "#FF8A3D"}
                onChange={(event) =>
                  draft &&
                  updateDraft({
                    ...draft,
                    appearance: {
                      ...draft.appearance,
                      accentColor: event.currentTarget.value,
                    },
                  })
                }
              />
            </label>

            <label className="settings-group__swatch">
              <span>Text color</span>
              <input
                type="color"
                value={draft?.appearance.textColor ?? "#F8FBFF"}
                onChange={(event) =>
                  draft &&
                  updateDraft({
                    ...draft,
                    appearance: {
                      ...draft.appearance,
                      textColor: event.currentTarget.value,
                    },
                  })
                }
              />
            </label>

            <label className="toggle-row">
              <span>Always on top</span>
              <input
                type="checkbox"
                checked={draft?.window.alwaysOnTop ?? true}
                onChange={(event) =>
                  draft &&
                  updateDraft({
                    ...draft,
                    window: {
                      ...draft.window,
                      alwaysOnTop: event.currentTarget.checked,
                    },
                  })
                }
              />
            </label>

            <label className="toggle-row">
              <span>Compact layout</span>
              <input
                type="checkbox"
                checked={draft?.appearance.compactMode ?? false}
                onChange={(event) =>
                  draft &&
                  updateDraft({
                    ...draft,
                    appearance: {
                      ...draft.appearance,
                      compactMode: event.currentTarget.checked,
                    },
                  })
                }
              />
            </label>

            <div className="settings-actions">
              <button
                className="primary-button"
                type="button"
                disabled={!isDirty || busyAction === "save-settings"}
                onClick={saveAppearanceSettings}
              >
                {busyAction === "save-settings" ? "Saving..." : "Save overlay settings"}
              </button>
              <button
                className="ghost-button"
                type="button"
                disabled={busyAction === "reset"}
                onClick={resetCounters}
              >
                {busyAction === "reset" ? "Resetting..." : "Reset counters"}
              </button>
            </div>
          </div>

          <div className="settings-group">
            <div>
              <p className="eyebrow">Connect VS Code</p>
              <h2>Live agent feed</h2>
              <p className="helper-copy">
                ShowMyToken listens on OTLP HTTP and patches VS Code to stream Copilot telemetry to
                the local collector with one click.
              </p>
            </div>

            <div className="editor-targets">
              {(snapshot?.editorTargets ?? []).map((target) => (
                <article className="editor-card" key={target.id}>
                  <div>
                    <strong>{target.label}</strong>
                    <span>{target.connected ? "Connected" : target.exists ? "Available" : "Not found"}</span>
                  </div>
                  <button
                    className="ghost-button"
                    type="button"
                    disabled={!target.exists || target.connected || busyAction === target.id}
                    onClick={() => connectEditor(target.id, target.label)}
                  >
                    {target.connected
                      ? "Ready"
                      : busyAction === target.id
                        ? "Connecting..."
                        : "Connect"}
                  </button>
                </article>
              ))}
            </div>

            <div className="supported-callout">
              <p className="eyebrow">Support matrix</p>
              <p>
                Copilot is production-ready now. Claude and Copilot CLI appear automatically when
                VS Code emits their OTel spans. External Cursor and standalone Codex feeds remain
                experimental until they expose stable local token telemetry.
              </p>
            </div>
          </div>
        </section>

        <footer className="footer-row">
          <span>Drag the header to reposition the overlay.</span>
          <span>v{snapshot?.appVersion ?? "0.1.0"}</span>
        </footer>

        {notice ? <div className="toast">{notice}</div> : null}
      </section>
    </main>
  );
}

export default App;
