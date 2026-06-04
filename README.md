# ShowMyToken

ShowMyToken is a cross-platform desktop token meter that keeps a live token count on the desktop instead of burying it inside a dashboard, log panel, or settings-heavy widget.

## What Ships Now

- Transparent always-on-top floating meter that defaults to just one live number
- Drag-to-reposition support with remembered window placement
- System tray entry for show, hide, settings, preview, connect, and quit
- Embedded OTLP collector inside the app process; users do not launch a separate local service
- Real-time GitHub Copilot token aggregation from VS Code agent telemetry
- Automatic detection for VS Code and VS Code Insiders settings files
- One-click VS Code connection flow that enables Copilot OTel streaming to the local collector
- Optional settings surface for opacity, color, font scale, preview, and connection state

## Product Positioning

The first production-ready connector is GitHub Copilot inside VS Code, because VS Code officially exposes OpenTelemetry spans with `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`.

Claude and Copilot CLI automatically appear when VS Code emits their spans through the same pipeline.

Cursor and standalone Codex remain experimental for now because they do not expose a stable, officially documented local token telemetry feed that can be consumed safely without reverse engineering.

## User Experience Contract

- The default desktop surface should stay minimal: one number and at most one visible control.
- Setup, connection, preview, hide, and quit belong in the tray or the secondary settings surface, not in the main meter.
- End users install one app. Node.js and Rust are build-time dependencies for development only, not runtime prerequisites for using the shipped product.

## Local Development

### Prerequisites

- Node.js 22+
- Rust stable
- Tauri desktop build prerequisites for your platform

### Install

```bash
npm install
```

### Run the desktop app

```bash
npm run tauri dev
```

### Validate the project

```bash
npm run validate
```

## Connect VS Code To ShowMyToken

1. Launch ShowMyToken.
2. Open the tray menu or the single meter button.
3. Click `Connect` for `VS Code` or `VS Code Insiders`.
4. Ask Copilot to do work in VS Code.
5. Watch the floating meter update when VS Code emits `invoke_agent` spans.

ShowMyToken listens locally on OTLP HTTP at `http://127.0.0.1:14318` and does not require prompt-content capture to display token usage.

## Validation Strategy

The project includes two verification layers:

- Frontend build validation via `npm run build`
- Rust collector and aggregation tests via `npm run test:backend`

## GitHub Actions

The repository includes two workflows:

- `validate.yml`: runs build and backend tests on every push and pull request
- `release.yml`: builds Windows, macOS, and Linux artifacts with Tauri and publishes them to a GitHub release

## Packaging Notes

- Windows, macOS, and Linux artifacts are built through the Tauri GitHub Action
- Unsigned artifacts are supported out of the box
- If you later want signed installers or updater bundles, add the relevant Tauri signing secrets in GitHub Actions
