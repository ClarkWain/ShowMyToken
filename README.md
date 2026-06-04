# ShowMyToken

ShowMyToken is a cross-platform desktop overlay that keeps live AI agent token usage on the desktop instead of buried inside a dashboard or log panel.

## What Ships Now

- Transparent always-on-top Tauri overlay with drag-to-reposition support
- Live OTLP collector on `http://127.0.0.1:14318/v1/traces`
- Real-time GitHub Copilot token aggregation from VS Code agent telemetry
- Automatic detection for VS Code and VS Code Insiders settings files
- One-click VS Code connection flow that enables Copilot OTel streaming to the local collector
- Animated token transitions, compact mode, color controls, font scaling, hide and quit actions
- Multi-agent UI surface for Copilot, Claude, Copilot CLI, and any other agent name that arrives through VS Code OTel

## Product Positioning

The first production-ready connector is GitHub Copilot inside VS Code, because VS Code officially exposes OpenTelemetry spans with `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`.

Claude and Copilot CLI automatically appear when VS Code emits their spans through the same pipeline.

Cursor and standalone Codex remain experimental for now because they do not expose a stable, officially documented local token telemetry feed that can be consumed safely without reverse engineering.

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
2. Open the settings drawer in the overlay.
3. Click `Connect` for `VS Code` or `VS Code Insiders`.
4. Ask Copilot to do work in VS Code.
5. Watch the overlay update when VS Code emits `invoke_agent` spans.

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
