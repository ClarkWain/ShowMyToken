use axum::{
    body::Bytes,
    extract::State as AxumState,
    http::StatusCode,
    routing::{get, post},
    Router,
};
use opentelemetry_proto::tonic::{
    collector::trace::v1::ExportTraceServiceRequest,
    common::v1::{AnyValue, KeyValue},
    trace::v1::Span,
};
use prost::Message;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
};

const COLLECTOR_SOCKET: &str = "127.0.0.1:14318";
const COLLECTOR_ENDPOINT: &str = "http://127.0.0.1:14318";
const SNAPSHOT_EVENT: &str = "show-my-token://snapshot";
const OPEN_SETTINGS_EVENT: &str = "show-my-token://open-settings";
const NOTICE_EVENT: &str = "show-my-token://notice";
const TRAY_SHOW_METER_ID: &str = "tray-show-meter";
const TRAY_OPEN_SETTINGS_ID: &str = "tray-open-settings";
const TRAY_PREVIEW_ID: &str = "tray-preview";
const TRAY_CONNECT_ID: &str = "tray-connect";
const TRAY_HIDE_METER_ID: &str = "tray-hide-meter";
const TRAY_QUIT_ID: &str = "tray-quit";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    appearance: AppearanceSettings,
    window: WindowSettings,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            appearance: AppearanceSettings {
                opacity: 0.76,
                font_scale: 1.0,
                text_color: "#F8FBFF".into(),
                accent_color: "#FF8A3D".into(),
                compact_mode: false,
            },
            window: WindowSettings {
                always_on_top: true,
                position: None,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppearanceSettings {
    opacity: f64,
    font_scale: f64,
    text_color: String,
    accent_color: String,
    compact_mode: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowSettings {
    always_on_top: bool,
    position: Option<WindowPosition>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowPosition {
    x: f64,
    y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectorStatus {
    endpoint: String,
    source_mode: String,
    status: String,
    connected: bool,
    message: String,
    error: Option<String>,
    last_event_unix_ms: Option<u64>,
}

impl Default for CollectorStatus {
    fn default() -> Self {
        Self {
            endpoint: COLLECTOR_ENDPOINT.into(),
            source_mode: "vsCodeOtlpHttp".into(),
            status: "starting".into(),
            connected: false,
            message: "Waiting for the first VS Code span or a preview pulse".into(),
            error: None,
            last_event_unix_ms: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderSnapshot {
    id: String,
    label: String,
    agent_name: String,
    provider_name: String,
    status: String,
    input_tokens: u64,
    output_tokens: u64,
    total_tokens: u64,
    requests: u64,
    recent_deltas: Vec<u64>,
    last_model: Option<String>,
    last_update_unix_ms: Option<u64>,
    source: String,
}

impl ProviderSnapshot {
    fn seed(id: &str, label: &str, agent_name: &str, provider_name: &str, source: &str) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            agent_name: agent_name.into(),
            provider_name: provider_name.into(),
            status: "standby".into(),
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            requests: 0,
            recent_deltas: Vec::new(),
            last_model: None,
            last_update_unix_ms: None,
            source: source.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditorTarget {
    id: String,
    label: String,
    settings_path: String,
    exists: bool,
    connected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DashboardSnapshot {
    settings: AppSettings,
    collector: CollectorStatus,
    providers: Vec<ProviderSnapshot>,
    editor_targets: Vec<EditorTarget>,
    app_version: String,
}

#[derive(Debug)]
struct RuntimeState {
    settings: AppSettings,
    collector: CollectorStatus,
    providers: HashMap<String, ProviderSnapshot>,
    seen_spans: HashSet<String>,
    seen_order: VecDeque<String>,
    server_started: bool,
}

impl RuntimeState {
    fn new(settings: AppSettings) -> Self {
        Self {
            settings,
            collector: CollectorStatus::default(),
            providers: provider_seeds(),
            seen_spans: HashSet::new(),
            seen_order: VecDeque::new(),
            server_started: false,
        }
    }
}

#[derive(Clone)]
struct SharedState(Arc<Kernel>);

struct Kernel {
    settings_path: PathBuf,
    runtime: Mutex<RuntimeState>,
}

impl SharedState {
    fn new(settings_path: PathBuf, settings: AppSettings) -> Self {
        Self(Arc::new(Kernel {
            settings_path,
            runtime: Mutex::new(RuntimeState::new(settings)),
        }))
    }

    fn snapshot(&self) -> DashboardSnapshot {
        build_snapshot(&self.0)
    }
}

#[derive(Clone)]
struct CollectorContext {
    app: AppHandle,
    shared: SharedState,
}

#[derive(Debug)]
struct UsageRecord {
    span_id: String,
    agent_name: String,
    provider_name: String,
    model: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
}

#[tauri::command]
fn bootstrap(shared: tauri::State<'_, SharedState>) -> Result<DashboardSnapshot, String> {
    Ok(shared.snapshot())
}

#[tauri::command]
fn save_settings(
    shared: tauri::State<'_, SharedState>,
    settings: AppSettings,
) -> Result<DashboardSnapshot, String> {
    {
        let mut runtime = shared
            .0
            .runtime
            .lock()
            .map_err(|_| "failed to lock app state".to_string())?;
        runtime.settings = settings.clone();
    }

    persist_settings(&shared.0.settings_path, &settings)?;
    Ok(shared.snapshot())
}

#[tauri::command]
fn save_window_position(
    shared: tauri::State<'_, SharedState>,
    x: f64,
    y: f64,
) -> Result<(), String> {
    let settings = {
        let mut runtime = shared
            .0
            .runtime
            .lock()
            .map_err(|_| "failed to lock app state".to_string())?;
        runtime.settings.window.position = Some(WindowPosition { x, y });
        runtime.settings.clone()
    };

    persist_settings(&shared.0.settings_path, &settings)
}

#[tauri::command]
fn connect_editor_target(
    target_id: String,
) -> Result<(), String> {
    let target = editor_targets()
        .into_iter()
        .find(|candidate| candidate.id == target_id)
        .ok_or_else(|| format!("unknown editor target: {target_id}"))?;

    patch_editor_settings(Path::new(&target.settings_path))
}

#[tauri::command]
fn preview_demo(shared: tauri::State<'_, SharedState>) -> Result<DashboardSnapshot, String> {
    Ok(inject_demo_snapshot(&shared, None))
}

#[tauri::command]
fn reset_counters(shared: tauri::State<'_, SharedState>) -> Result<DashboardSnapshot, String> {
    {
        let mut runtime = shared
            .0
            .runtime
            .lock()
            .map_err(|_| "failed to lock app state".to_string())?;
        runtime.providers = provider_seeds();
        runtime.seen_spans.clear();
        runtime.seen_order.clear();
        runtime.collector.connected = false;
        runtime.collector.last_event_unix_ms = None;
        runtime.collector.status = "listening".into();
        runtime.collector.message = "Collector reset. Waiting for the next agent span or preview pulse".into();
    }

    Ok(shared.snapshot())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn hide_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.minimize();
    }
}

fn emit_notice(app: &AppHandle, message: impl Into<String>) {
    let _ = app.emit(NOTICE_EVENT, message.into());
}

fn open_settings_panel(app: &AppHandle) {
    show_main_window(app);
    let _ = app.emit(OPEN_SETTINGS_EVENT, true);
}

fn connect_primary_editor_target() -> Result<String, String> {
    let target = editor_targets()
        .into_iter()
        .find(|candidate| candidate.exists && !candidate.connected)
        .or_else(|| editor_targets().into_iter().find(|candidate| candidate.exists))
        .ok_or_else(|| "No supported VS Code installation was found.".to_string())?;

    patch_editor_settings(Path::new(&target.settings_path))?;
    Ok(target.label)
}

fn build_tray(app: &AppHandle, shared: SharedState) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text(TRAY_SHOW_METER_ID, "Show meter")
        .text(TRAY_OPEN_SETTINGS_ID, "Open settings")
        .text(TRAY_PREVIEW_ID, "Preview tokens")
        .text(TRAY_CONNECT_ID, "Connect VS Code")
        .separator()
        .text(TRAY_HIDE_METER_ID, "Hide meter")
        .text(TRAY_QUIT_ID, "Quit ShowMyToken")
        .build()?;
    let icon = app
        .default_window_icon()
        .cloned()
        .expect("default window icon should exist for tray");
    let shared_for_menu = shared.clone();

    TrayIconBuilder::with_id("show-my-token-tray")
        .icon(icon)
        .tooltip("ShowMyToken")
        .show_menu_on_left_click(false)
        .menu(&menu)
        .on_tray_icon_event(|tray, event| {
            let left_click = matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            );
            let left_double_click = matches!(
                event,
                TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            );

            if left_double_click {
                open_settings_panel(tray.app_handle());
            } else if left_click {
                show_main_window(tray.app_handle());
            }
        })
        .on_menu_event(move |app, event| match event.id().as_ref() {
            TRAY_SHOW_METER_ID => {
                show_main_window(app);
            }
            TRAY_OPEN_SETTINGS_ID => {
                open_settings_panel(app);
            }
            TRAY_PREVIEW_ID => {
                inject_demo_snapshot(&shared_for_menu, Some(app));
                show_main_window(app);
                emit_notice(app, "Preview tokens injected.");
            }
            TRAY_CONNECT_ID => match connect_primary_editor_target() {
                Ok(label) => {
                    show_main_window(app);
                    let _ = app.emit(SNAPSHOT_EVENT, shared_for_menu.snapshot());
                    emit_notice(app, format!("{label} is now patched for live Copilot telemetry."));
                }
                Err(error) => {
                    open_settings_panel(app);
                    emit_notice(app, error);
                }
            },
            TRAY_HIDE_METER_ID => {
                hide_main_window(app);
            }
            TRAY_QUIT_ID => {
                quit_app(app.clone());
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}

fn provider_seeds() -> HashMap<String, ProviderSnapshot> {
    let presets = [
        ProviderSnapshot::seed("copilot", "GitHub Copilot", "copilot", "github", "vsCodeOtlp"),
        ProviderSnapshot::seed("claude", "Claude", "claude", "anthropic", "vsCodeOtlp"),
        ProviderSnapshot::seed("copilotcli", "Copilot CLI", "copilotcli", "github", "vsCodeOtlp"),
        ProviderSnapshot::seed(
            "custom",
            "Custom Agent",
            "custom",
            "custom",
            "customConnector",
        ),
    ];

    presets
        .into_iter()
        .map(|provider| (provider.id.clone(), provider))
        .collect()
}

fn build_snapshot(kernel: &Kernel) -> DashboardSnapshot {
    let runtime = kernel
        .runtime
        .lock()
        .expect("runtime state should not be poisoned");

    let mut providers = runtime.providers.values().cloned().collect::<Vec<_>>();
    providers.sort_by(|left, right| {
        right
            .total_tokens
            .cmp(&left.total_tokens)
            .then_with(|| left.label.cmp(&right.label))
    });

    DashboardSnapshot {
        settings: runtime.settings.clone(),
        collector: runtime.collector.clone(),
        providers,
        editor_targets: editor_targets(),
        app_version: env!("CARGO_PKG_VERSION").into(),
    }
}

fn editor_targets() -> Vec<EditorTarget> {
    candidate_editor_settings()
        .into_iter()
        .map(|(id, label, path)| EditorTarget {
            id: id.into(),
            label: label.into(),
            settings_path: path.display().to_string(),
            exists: path.exists(),
            connected: is_editor_target_connected(&path),
        })
        .collect()
}

fn candidate_editor_settings() -> Vec<(&'static str, &'static str, PathBuf)> {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));

    vec![
        (
            "vscode-insiders",
            "VS Code Insiders",
            base.join("Code - Insiders").join("User").join("settings.json"),
        ),
        (
            "vscode",
            "VS Code",
            base.join("Code").join("User").join("settings.json"),
        ),
    ]
}

fn is_editor_target_connected(path: &Path) -> bool {
    let Ok(raw) = fs::read_to_string(path) else {
        return false;
    };

    let Ok(json) = serde_json::from_str::<Value>(&raw) else {
        return false;
    };

    let Some(map) = json.as_object() else {
        return false;
    };

    map.get("github.copilot.chat.otel.enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && map
            .get("github.copilot.chat.otel.exporterType")
            .and_then(Value::as_str)
            .unwrap_or_default()
            == "otlp-http"
        && map
            .get("github.copilot.chat.otel.otlpEndpoint")
            .and_then(Value::as_str)
            .unwrap_or_default()
            == COLLECTOR_ENDPOINT
}

fn patch_editor_settings(path: &Path) -> Result<(), String> {
    let mut document = if path.exists() {
        let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
        serde_json::from_str::<Value>(&raw).map_err(|error| error.to_string())?
    } else {
        json!({})
    };

    let object = document
        .as_object_mut()
        .ok_or_else(|| "editor settings must contain a JSON object".to_string())?;

    object.insert("github.copilot.chat.otel.enabled".into(), json!(true));
    object.insert("github.copilot.chat.otel.exporterType".into(), json!("otlp-http"));
    object.insert("github.copilot.chat.otel.otlpEndpoint".into(), json!(COLLECTOR_ENDPOINT));

    if !object.contains_key("github.copilot.chat.otel.captureContent") {
        object.insert("github.copilot.chat.otel.captureContent".into(), json!(false));
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let serialized = serde_json::to_string_pretty(&document).map_err(|error| error.to_string())?;
    fs::write(path, format!("{serialized}\n")).map_err(|error| error.to_string())
}

fn default_settings_path() -> PathBuf {
    let config_root = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    config_root.join("ShowMyToken").join("settings.json")
}

fn load_settings(path: &Path) -> AppSettings {
    let Ok(raw) = fs::read_to_string(path) else {
        return AppSettings::default();
    };

    serde_json::from_str::<AppSettings>(&raw).unwrap_or_default()
}

fn persist_settings(path: &Path, settings: &AppSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let serialized = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    fs::write(path, format!("{serialized}\n")).map_err(|error| error.to_string())
}

fn inject_demo_snapshot(shared: &SharedState, app: Option<&AppHandle>) -> DashboardSnapshot {
    let now = unix_ms();

    if let Ok(mut runtime) = shared.0.runtime.lock() {
        runtime.collector.connected = true;
        runtime.collector.status = "preview".into();
        runtime.collector.message = "Preview pulse injected locally. Connect VS Code when you are ready for live Copilot usage.".into();
        runtime.collector.error = None;
        runtime.collector.last_event_unix_ms = Some(now);

        for record in demo_usage_records(now) {
            let _ = apply_usage_record(&mut runtime, record, now);
        }
    }

    let snapshot = shared.snapshot();

    if let Some(app) = app {
        let _ = app.emit(SNAPSHOT_EVENT, snapshot.clone());
    }

    snapshot
}

fn demo_usage_records(now: u64) -> Vec<UsageRecord> {
    vec![
        UsageRecord {
            span_id: format!("demo-copilot-{now}"),
            agent_name: "copilot".into(),
            provider_name: "github".into(),
            model: Some("gpt-4.1".into()),
            input_tokens: 1482,
            output_tokens: 224,
        },
        UsageRecord {
            span_id: format!("demo-claude-{now}"),
            agent_name: "claude".into(),
            provider_name: "anthropic".into(),
            model: Some("claude-4-sonnet".into()),
            input_tokens: 832,
            output_tokens: 128,
        },
        UsageRecord {
            span_id: format!("demo-copilotcli-{now}"),
            agent_name: "copilotcli".into(),
            provider_name: "github".into(),
            model: Some("gpt-4.1-mini".into()),
            input_tokens: 320,
            output_tokens: 64,
        },
    ]
}

fn update_collector_status(shared: &SharedState, app: &AppHandle, mutate: impl FnOnce(&mut RuntimeState)) {
    if let Ok(mut runtime) = shared.0.runtime.lock() {
        mutate(&mut runtime);
    }

    let snapshot = shared.snapshot();
    let _ = app.emit(SNAPSHOT_EVENT, snapshot);
}

fn start_collector(app: AppHandle, shared: SharedState) {
    let should_start = {
        let mut runtime = shared
            .0
            .runtime
            .lock()
            .expect("runtime state should not be poisoned");

        if runtime.server_started {
            false
        } else {
            runtime.server_started = true;
            true
        }
    };

    if !should_start {
        return;
    }

    let collector = CollectorContext {
        app: app.clone(),
        shared: shared.clone(),
    };

    tauri::async_runtime::spawn(async move {
        match tokio::net::TcpListener::bind(COLLECTOR_SOCKET).await {
            Ok(listener) => {
                update_collector_status(&collector.shared, &collector.app, |runtime| {
                    runtime.collector.status = "listening".into();
                    runtime.collector.message =
                        format!("Live OTLP collector ready at {COLLECTOR_ENDPOINT}/v1/traces");
                    runtime.collector.error = None;
                });

                let router = Router::new()
                    .route("/healthz", get(healthz))
                    .route("/debug/demo", post(demo_pulse))
                    .route("/v1/traces", post(ingest_traces))
                    .with_state(collector.clone());

                if let Err(error) = axum::serve(listener, router).await {
                    update_collector_status(&collector.shared, &collector.app, |runtime| {
                        runtime.collector.status = "error".into();
                        runtime.collector.error = Some(error.to_string());
                        runtime.collector.message =
                            "Collector stopped unexpectedly. Restart the app to recover.".into();
                    });
                }
            }
            Err(error) => {
                update_collector_status(&collector.shared, &collector.app, |runtime| {
                    runtime.collector.status = "error".into();
                    runtime.collector.error = Some(error.to_string());
                    runtime.collector.message =
                        "The default ShowMyToken collector port is busy. Pick a new local port or stop the conflicting collector.".into();
                });
            }
        }
    });
}

async fn healthz() -> &'static str {
    "ok"
}

async fn demo_pulse(
    AxumState(context): AxumState<CollectorContext>,
) -> StatusCode {
    inject_demo_snapshot(&context.shared, Some(&context.app));
    StatusCode::OK
}

async fn ingest_traces(
    AxumState(context): AxumState<CollectorContext>,
    body: Bytes,
) -> StatusCode {
    let Ok(records) = decode_usage_records(body.as_ref()) else {
        return StatusCode::BAD_REQUEST;
    };

    if records.is_empty() {
        return StatusCode::OK;
    }

    let now = unix_ms();
    let mut changed = false;

    if let Ok(mut runtime) = context.shared.0.runtime.lock() {
        runtime.collector.connected = true;
        runtime.collector.status = "live".into();
        runtime.collector.message = "Receiving live agent spans from VS Code".into();
        runtime.collector.error = None;
        runtime.collector.last_event_unix_ms = Some(now);

        for record in records {
            if apply_usage_record(&mut runtime, record, now) {
                changed = true;
            }
        }
    }

    if changed {
        let snapshot = context.shared.snapshot();
        let _ = context.app.emit(SNAPSHOT_EVENT, snapshot);
    }

    StatusCode::OK
}

fn decode_usage_records(payload: &[u8]) -> Result<Vec<UsageRecord>, String> {
    let request = ExportTraceServiceRequest::decode(payload).map_err(|error| error.to_string())?;
    let mut records = Vec::new();

    for resource_spans in request.resource_spans {
        for scope_spans in resource_spans.scope_spans {
            for span in scope_spans.spans {
                if let Some(record) = decode_usage_span(span) {
                    records.push(record);
                }
            }
        }
    }

    Ok(records)
}

fn decode_usage_span(span: Span) -> Option<UsageRecord> {
    let attributes = attributes_to_map(&span.attributes);
    let operation = attr_string(&attributes, "gen_ai.operation.name")
        .or_else(|| parse_operation_from_span_name(&span.name))?;

    if operation != "invoke_agent" {
        return None;
    }

    let input_tokens = attr_u64(&attributes, "gen_ai.usage.input_tokens").unwrap_or(0);
    let output_tokens = attr_u64(&attributes, "gen_ai.usage.output_tokens").unwrap_or(0);

    if input_tokens == 0 && output_tokens == 0 {
        return None;
    }

    let agent_name = attr_string(&attributes, "gen_ai.agent.name")
        .or_else(|| parse_agent_from_span_name(&span.name))
        .unwrap_or_else(|| "copilot".into());
    let provider_name =
        attr_string(&attributes, "gen_ai.provider.name").unwrap_or_else(|| "github".into());

    Some(UsageRecord {
        span_id: bytes_to_hex(&span.span_id),
        agent_name,
        provider_name,
        model: attr_string(&attributes, "gen_ai.response.model")
            .or_else(|| attr_string(&attributes, "gen_ai.request.model")),
        input_tokens,
        output_tokens,
    })
}

fn apply_usage_record(runtime: &mut RuntimeState, record: UsageRecord, now: u64) -> bool {
    if record.span_id.is_empty() || runtime.seen_spans.contains(&record.span_id) {
        return false;
    }

    runtime.seen_spans.insert(record.span_id.clone());
    runtime.seen_order.push_back(record.span_id);

    while runtime.seen_order.len() > 2048 {
        if let Some(oldest) = runtime.seen_order.pop_front() {
            runtime.seen_spans.remove(&oldest);
        }
    }

    let provider_key = provider_key(&record.agent_name, &record.provider_name);
    let entry = runtime.providers.entry(provider_key.clone()).or_insert_with(|| {
        ProviderSnapshot::seed(
            &provider_key,
            &provider_label(&record.agent_name),
            &record.agent_name,
            &record.provider_name,
            "vsCodeOtlp",
        )
    });

    entry.status = "live".into();
    entry.agent_name = record.agent_name;
    entry.provider_name = record.provider_name;
    entry.input_tokens += record.input_tokens;
    entry.output_tokens += record.output_tokens;
    entry.total_tokens = entry.input_tokens + entry.output_tokens;
    entry.requests += 1;
    entry.last_model = record.model;
    entry.last_update_unix_ms = Some(now);
    entry.recent_deltas.push(record.input_tokens + record.output_tokens);

    if entry.recent_deltas.len() > 20 {
        entry.recent_deltas.remove(0);
    }

    true
}

fn provider_key(agent_name: &str, provider_name: &str) -> String {
    let agent = agent_name.to_lowercase();

    if agent.contains("copilotcli") {
        return "copilotcli".into();
    }

    if agent.contains("copilot") || provider_name.eq_ignore_ascii_case("github") {
        return "copilot".into();
    }

    if agent.contains("claude") {
        return "claude".into();
    }

    let sanitized = agent
        .chars()
        .map(|character| if character.is_ascii_alphanumeric() { character } else { '-' })
        .collect::<String>();

    sanitized.trim_matches('-').to_string()
}

fn provider_label(agent_name: &str) -> String {
    let lower = agent_name.to_lowercase();

    if lower.contains("copilotcli") {
        return "Copilot CLI".into();
    }

    if lower.contains("copilot") {
        return "GitHub Copilot".into();
    }

    if lower.contains("claude") {
        return "Claude".into();
    }

    agent_name
        .split(['-', '_', ' '])
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            let mut characters = segment.chars();
            match characters.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), characters.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn attributes_to_map(attributes: &[KeyValue]) -> HashMap<String, String> {
    let mut collected = HashMap::new();

    for item in attributes {
        if let Some(value) = any_value_to_string(item.value.as_ref()) {
            collected.insert(item.key.clone(), value);
        }
    }

    collected
}

fn any_value_to_string(value: Option<&AnyValue>) -> Option<String> {
    use opentelemetry_proto::tonic::common::v1::any_value::Value as OtlpValue;

    match value?.value.as_ref()? {
        OtlpValue::StringValue(value) => Some(value.clone()),
        OtlpValue::StringValueStrindex(_) => None,
        OtlpValue::BoolValue(value) => Some(value.to_string()),
        OtlpValue::IntValue(value) => Some(value.to_string()),
        OtlpValue::DoubleValue(value) => Some(value.to_string()),
        OtlpValue::BytesValue(value) => Some(bytes_to_hex(value)),
        OtlpValue::ArrayValue(value) => Some(
            value
                .values
                .iter()
                .filter_map(|item| any_value_to_string(Some(item)))
                .collect::<Vec<_>>()
                .join(", "),
        ),
        OtlpValue::KvlistValue(value) => Some(format!("{} keys", value.values.len())),
    }
}

fn attr_string(attributes: &HashMap<String, String>, key: &str) -> Option<String> {
    attributes
        .get(key)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn attr_u64(attributes: &HashMap<String, String>, key: &str) -> Option<u64> {
    let raw = attributes.get(key)?;

    raw.parse::<u64>()
        .ok()
        .or_else(|| raw.parse::<f64>().ok().map(|value| value.round() as u64))
}

fn parse_operation_from_span_name(name: &str) -> Option<String> {
    name.split_whitespace().next().map(ToString::to_string)
}

fn parse_agent_from_span_name(name: &str) -> Option<String> {
    let mut segments = name.split_whitespace();
    let operation = segments.next()?;

    if operation != "invoke_agent" {
        return None;
    }

    segments.next().map(ToString::to_string)
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let settings_path = default_settings_path();
    let settings = load_settings(&settings_path);
    let shared = SharedState::new(settings_path, settings);
    let setup_state = shared.clone();

    tauri::Builder::default()
        .manage(shared)
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            start_collector(app.handle().clone(), setup_state.clone());
            build_tray(&app.handle(), setup_state.clone())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            save_settings,
            save_window_position,
            connect_editor_target,
            preview_demo,
            reset_counters,
            quit_app
        ])
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }

            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.minimize();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry_proto::tonic::{
        collector::trace::v1::ExportTraceServiceRequest,
        common::v1::{any_value::Value as OtlpValue, AnyValue, KeyValue},
        resource::v1::Resource,
        trace::v1::{ResourceSpans, ScopeSpans, Span},
    };
    use prost::Message;

    #[test]
    fn decode_usage_records_extracts_invoke_agent_tokens() {
        let request = ExportTraceServiceRequest {
            resource_spans: vec![ResourceSpans {
                resource: Some(Resource::default()),
                scope_spans: vec![ScopeSpans {
                    scope: None,
                    spans: vec![Span {
                        trace_id: vec![1; 16],
                        span_id: vec![2; 8],
                        trace_state: String::new(),
                        parent_span_id: vec![],
                        flags: 0,
                        name: "invoke_agent copilot".into(),
                        kind: 1,
                        start_time_unix_nano: 0,
                        end_time_unix_nano: 0,
                        attributes: vec![
                            kv_str("gen_ai.operation.name", "invoke_agent"),
                            kv_str("gen_ai.agent.name", "copilot"),
                            kv_str("gen_ai.provider.name", "github"),
                            kv_int("gen_ai.usage.input_tokens", 128),
                            kv_int("gen_ai.usage.output_tokens", 64),
                            kv_str("gen_ai.response.model", "gpt-4.1"),
                        ],
                        dropped_attributes_count: 0,
                        events: vec![],
                        dropped_events_count: 0,
                        links: vec![],
                        dropped_links_count: 0,
                        status: None,
                    }],
                    schema_url: String::new(),
                }],
                schema_url: String::new(),
            }],
        };

        let payload = request.encode_to_vec();
        let records = decode_usage_records(&payload).expect("records should decode");

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].agent_name, "copilot");
        assert_eq!(records[0].input_tokens, 128);
        assert_eq!(records[0].output_tokens, 64);
        assert_eq!(records[0].model.as_deref(), Some("gpt-4.1"));
    }

    #[test]
    fn apply_usage_record_deduplicates_span_ids() {
        let mut runtime = RuntimeState::new(AppSettings::default());
        let record = UsageRecord {
            span_id: "abc123".into(),
            agent_name: "copilot".into(),
            provider_name: "github".into(),
            model: Some("gpt-4.1".into()),
            input_tokens: 40,
            output_tokens: 20,
        };

        assert!(apply_usage_record(&mut runtime, record, 1));
        assert!(!apply_usage_record(
            &mut runtime,
            UsageRecord {
                span_id: "abc123".into(),
                agent_name: "copilot".into(),
                provider_name: "github".into(),
                model: None,
                input_tokens: 40,
                output_tokens: 20,
            },
            2,
        ));

        let copilot = runtime.providers.get("copilot").expect("copilot provider exists");
        assert_eq!(copilot.total_tokens, 60);
        assert_eq!(copilot.requests, 1);
    }

    fn kv_str(key: &str, value: &str) -> KeyValue {
        KeyValue {
            key: key.into(),
            key_strindex: 0,
            value: Some(AnyValue {
                value: Some(OtlpValue::StringValue(value.into())),
            }),
        }
    }

    fn kv_int(key: &str, value: i64) -> KeyValue {
        KeyValue {
            key: key.into(),
            key_strindex: 0,
            value: Some(AnyValue {
                value: Some(OtlpValue::IntValue(value)),
            }),
        }
    }
}
