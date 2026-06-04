import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  currentMonitor,
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
} from "@tauri-apps/api/window";
import {
  startTransition,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import "./App.css";

const SNAPSHOT_EVENT = "show-my-token://snapshot";
const OPEN_SETTINGS_EVENT = "show-my-token://open-settings";
const NOTICE_EVENT = "show-my-token://notice";
const hasTauriRuntime = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const windowHandle = hasTauriRuntime ? getCurrentWindow() : null;
const numberFormatter = new Intl.NumberFormat("en-US");
const FLOAT_WINDOW_SIZE = { width: 280, height: 108 };
const SETTINGS_WINDOW_SIZE = { width: 552, height: 452 };
const PROVIDER_PRIORITY: Record<string, number> = {
  copilot: 0,
  claude: 1,
  copilotcli: 2,
};

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

function formatCompactRelativeTime(unixMs: number | null) {
  if (!unixMs) {
    return "waiting";
  }

  const deltaSeconds = Math.max(0, Math.round((Date.now() - unixMs) / 1000));

  if (deltaSeconds < 5) {
    return "now";
  }

  if (deltaSeconds < 60) {
    return `${deltaSeconds}s`;
  }

  return `${Math.round(deltaSeconds / 60)}m`;
}

function formatCollectorEndpoint(endpoint: string | null | undefined) {
  if (!endpoint) {
    return "127.0.0.1:14318";
  }

  try {
    const url = new URL(endpoint);
    return url.host;
  } catch {
    return endpoint.replace(/^https?:\/\//, "");
  }
}

function createPreviewSnapshot(): DashboardSnapshot {
  return {
    settings: {
      appearance: {
        opacity: 0.76,
        fontScale: 1,
        textColor: "#F8FBFF",
        accentColor: "#FF8A3D",
        compactMode: false,
      },
      window: {
        alwaysOnTop: true,
        position: null,
      },
    },
    collector: {
      endpoint: "http://127.0.0.1:14318",
      sourceMode: "preview",
      status: "preview",
      connected: true,
      message: "Preview traffic is visible.",
      error: null,
      lastEventUnixMs: Date.now(),
    },
    providers: [
      {
        id: "copilot",
        label: "GitHub Copilot",
        agentName: "copilot",
        providerName: "github",
        status: "preview",
        inputTokens: 2200,
        outputTokens: 800,
        totalTokens: 3000,
        requests: 12,
        recentDeltas: [120, 260, 180, 340, 480, 360, 520, 740],
        lastModel: "gpt-4.1",
        lastUpdateUnixMs: Date.now(),
        source: "preview",
      },
      {
        id: "claude",
        label: "Claude Code",
        agentName: "claude",
        providerName: "anthropic",
        status: "idle",
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        requests: 0,
        recentDeltas: [],
        lastModel: null,
        lastUpdateUnixMs: null,
        source: "preview",
      },
      {
        id: "copilotcli",
        label: "Copilot CLI",
        agentName: "copilotcli",
        providerName: "github",
        status: "idle",
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        requests: 0,
        recentDeltas: [],
        lastModel: null,
        lastUpdateUnixMs: null,
        source: "preview",
      },
    ],
    editorTargets: [
      {
        id: "vscode",
        label: "VS Code",
        settingsPath: "preview",
        exists: true,
        connected: false,
      },
      {
        id: "vscode-insiders",
        label: "VS Code Insiders",
        settingsPath: "preview",
        exists: true,
        connected: false,
      },
    ],
    appVersion: "0.1.0",
  };
}

const browserPreviewSnapshot = hasTauriRuntime ? null : createPreviewSnapshot();

function App() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(browserPreviewSnapshot);
  const [draft, setDraft] = useState<AppSettings | null>(browserPreviewSnapshot?.settings ?? null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const startupApplied = useRef(false);
  const moveTimer = useRef<number | null>(null);

  const applyWindowPreferences = useEffectEvent(async (settings: AppSettings) => {
    if (!windowHandle) {
      return;
    }

    await windowHandle.setAlwaysOnTop(settings.window.alwaysOnTop);

    const monitor = await currentMonitor();

    if (monitor) {
      const size = await windowHandle.innerSize();
      const padding = 24;
      const minX = monitor.position.x + padding;
      const minY = monitor.position.y + padding;
      const maxX = Math.max(minX, monitor.position.x + monitor.size.width - size.width - padding);
      const maxY = Math.max(minY, monitor.position.y + monitor.size.height - size.height - padding);
      const target = settings.window.position ?? { x: maxX, y: minY };
      const clampedX = Math.min(Math.max(target.x, minX), maxX);
      const clampedY = Math.min(Math.max(target.y, minY), maxY);

      await windowHandle.setPosition(
        new PhysicalPosition(Math.round(clampedX), Math.round(clampedY)),
      );

      return;
    }

    if (settings.window.position) {
      await windowHandle.setPosition(
        new PhysicalPosition(
          Math.round(settings.window.position.x),
          Math.round(settings.window.position.y),
        ),
      );
    }
  });

  const syncWindowSize = useEffectEvent(async (expanded: boolean, settings: AppSettings | null) => {
    if (!windowHandle || !settings) {
      return;
    }

    const target = expanded ? SETTINGS_WINDOW_SIZE : FLOAT_WINDOW_SIZE;
    await windowHandle.setSize(new LogicalSize(target.width, target.height));
    await applyWindowPreferences(settings);
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
    if (!hasTauriRuntime) {
      hydrateSnapshot(createPreviewSnapshot(), reason);
      return;
    }

    const nextSnapshot = await invoke<DashboardSnapshot>("bootstrap");
    hydrateSnapshot(nextSnapshot, reason);
  });

  useEffect(() => {
    if (!hasTauriRuntime || !windowHandle) {
      return;
    }

    void reloadSnapshot("boot");

    let unlistenSnapshot: (() => void) | undefined;
    let unlistenMove: (() => void) | undefined;
    let unlistenOpenSettings: (() => void) | undefined;
    let unlistenNotice: (() => void) | undefined;

    void listen<DashboardSnapshot>(SNAPSHOT_EVENT, ({ payload }) => {
      hydrateSnapshot(payload, "event");
    }).then((dispose) => {
      unlistenSnapshot = dispose;
    });

    void listen(OPEN_SETTINGS_EVENT, () => {
      setSettingsOpen(true);
    }).then((dispose) => {
      unlistenOpenSettings = dispose;
    });

    void listen<string>(NOTICE_EVENT, ({ payload }) => {
      setNotice(payload);
    }).then((dispose) => {
      unlistenNotice = dispose;
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
      unlistenOpenSettings?.();
      unlistenNotice?.();

      if (moveTimer.current !== null) {
        window.clearTimeout(moveTimer.current);
      }
    };
  }, [hydrateSnapshot, reloadSnapshot]);

  useEffect(() => {
    if (!hasTauriRuntime) {
      return;
    }

    void syncWindowSize(settingsOpen, draft ?? snapshot?.settings ?? null);
  }, [settingsOpen, syncWindowSize]);

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

    if (!hasTauriRuntime) {
      setSnapshot((current) => (current ? { ...current, settings: draft } : current));
      setIsDirty(false);
      setNotice("Preview mode only.");
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
    if (!hasTauriRuntime) {
      setNotice(`${label} preview is available in the desktop app.`);
      return;
    }

    setBusyAction(targetId);

    try {
      await invoke("connect_editor_target", { targetId });
      await reloadSnapshot("reload");
      setNotice(`${label} is now streaming OTLP into ShowMyToken.`);
    } finally {
      setBusyAction(null);
    }
  }

  async function previewTokens() {
    if (!hasTauriRuntime) {
      const nextSnapshot = createPreviewSnapshot();
      hydrateSnapshot(nextSnapshot, "reload");
      setNotice("Preview tokens injected.");
      return;
    }

    setBusyAction("preview-demo");

    try {
      const nextSnapshot = await invoke<DashboardSnapshot>("preview_demo");
      hydrateSnapshot(nextSnapshot, "reload");
      setNotice("Preview tokens injected.");
    } finally {
      setBusyAction(null);
    }
  }

  async function resetCounters() {
    if (!hasTauriRuntime) {
      const nextSnapshot = createPreviewSnapshot();
      nextSnapshot.providers = nextSnapshot.providers.map((provider) => ({
        ...provider,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        requests: 0,
        recentDeltas: [],
        lastModel: null,
        lastUpdateUnixMs: null,
      }));
      nextSnapshot.collector.connected = false;
      nextSnapshot.collector.message = "Waiting for live agent traffic.";
      hydrateSnapshot(nextSnapshot, "reload");
      setNotice("Token counters reset.");
      return;
    }

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
    if (!windowHandle) {
      setNotice("Hide is available in the desktop app.");
      return;
    }

    await windowHandle.minimize();
    setNotice("Overlay minimized. Use the taskbar icon to show it again.");
  }

  async function quitOverlay() {
    if (!hasTauriRuntime) {
      setNotice("Quit is available in the desktop app.");
      return;
    }

    await invoke("quit_app");
  }

  function updateDraft(nextDraft: AppSettings) {
    setDraft(nextDraft);
    setIsDirty(true);
  }

  const visibleProviders = [
    ...(snapshot?.providers.filter(
      (provider) =>
        provider.totalTokens > 0 || ["copilot", "claude", "copilotcli"].includes(provider.id),
    ) ?? []),
  ].sort((left, right) => {
    const totalDelta = right.totalTokens - left.totalTokens;

    if (totalDelta !== 0) {
      return totalDelta;
    }

    const leftIsActive = left.status === "live" || left.status === "preview";
    const rightIsActive = right.status === "live" || right.status === "preview";

    if (leftIsActive !== rightIsActive) {
      return Number(rightIsActive) - Number(leftIsActive);
    }

    const priorityDelta =
      (PROVIDER_PRIORITY[left.id] ?? Number.MAX_SAFE_INTEGER) -
      (PROVIDER_PRIORITY[right.id] ?? Number.MAX_SAFE_INTEGER);

    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    return (right.lastUpdateUnixMs ?? 0) - (left.lastUpdateUnixMs ?? 0);
  });
  const totalInput = visibleProviders.reduce((sum, provider) => sum + provider.inputTokens, 0);
  const totalOutput = visibleProviders.reduce((sum, provider) => sum + provider.outputTokens, 0);
  const totalTokens = totalInput + totalOutput;
  const topProvider =
    visibleProviders.find((provider) => provider.totalTokens > 0) ?? visibleProviders[0] ?? null;
  const primaryConnectTarget =
    snapshot?.editorTargets.find((target) => target.exists && !target.connected) ?? null;
  const collectorEndpoint = formatCollectorEndpoint(snapshot?.collector.endpoint);
  const productLabel = topProvider?.label ?? "GitHub Copilot";
  const meterVisualState =
    snapshot?.collector.status === "preview"
      ? "preview"
      : snapshot?.collector.connected
        ? "live"
        : "idle";
  const meterHint =
    totalTokens > 0
      ? `${productLabel} · ${meterVisualState} · ${formatCompactRelativeTime(snapshot?.collector.lastEventUnixMs ?? null)}`
      : primaryConnectTarget
        ? `Connect ${primaryConnectTarget.label} from tray`
        : "Use the tray to connect VS Code";
  const animatedTotal = useAnimatedNumber(totalTokens);

  useEffect(() => {
    const root = document.documentElement;

    root.style.setProperty("--panel-opacity", String(draft?.appearance.opacity ?? 0.76));
    root.style.setProperty("--panel-scale", String(draft?.appearance.fontScale ?? 1));
    root.style.setProperty("--panel-text", draft?.appearance.textColor ?? "#F8FBFF");
    root.style.setProperty("--panel-accent", draft?.appearance.accentColor ?? "#FF8A3D");
  }, [
    draft?.appearance.accentColor,
    draft?.appearance.fontScale,
    draft?.appearance.opacity,
    draft?.appearance.textColor,
  ]);

  return (
    <main className={`shell ${!hasTauriRuntime ? "shell--browser-preview" : ""} ${settingsOpen ? "shell--expanded" : ""}`}>
      <section className={`meter-shell ${settingsOpen ? "meter-shell--expanded" : ""}`}>
        <article
          className={`meter-card meter-card--${meterVisualState}`}
          onContextMenu={(event) => {
            event.preventDefault();
            setSettingsOpen((open) => !open);
          }}
          onDoubleClick={() => setSettingsOpen((open) => !open)}
          title={`${meterHint}. Right-click or use the button for settings.`}
        >
          <div className="meter-inline" data-tauri-drag-region>
            <strong className="meter-number">{formatTokenCount(animatedTotal)}</strong>
            <button
              className="meter-menu-button"
              type="button"
              aria-label={settingsOpen ? "Hide settings" : `Show settings for ${productLabel}`}
              onClick={() => setSettingsOpen((open) => !open)}
            >
              ...
            </button>
          </div>
        </article>

        <section className={`settings-drawer ${settingsOpen ? "settings-drawer--open" : ""}`}>
          <div className="settings-group">
            <div>
              <p className="eyebrow">Appearance</p>
              <h2>Meter tuning</h2>
              <p className="helper-copy">Default view stays tiny. Use this panel only when you need to tune it.</p>
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
              <button className="ghost-button" type="button" onClick={previewTokens}>
                Preview tokens
              </button>
              <button className="ghost-button" type="button" onClick={() => setSettingsOpen(false)}>
                Close settings
              </button>
            </div>
          </div>

          <div className="settings-group">
            <div>
              <p className="eyebrow">Source</p>
              <h2>Live token feed</h2>
              <p className="helper-copy">
                Connect VS Code once, then keep the meter small and out of your way.
              </p>
              <p className="settings-note">Collector endpoint: {collectorEndpoint}</p>
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

            <div className="settings-actions">
              <button className="ghost-button" type="button" onClick={hideOverlay}>
                Hide meter
              </button>
              <button className="ghost-button ghost-button--danger" type="button" onClick={quitOverlay}>
                Quit app
              </button>
            </div>
          </div>
        </section>

        {notice ? <div className="toast">{notice}</div> : null}
      </section>
    </main>
  );
}

export default App;
