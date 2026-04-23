# Ollmcp Desktop GUI

Desktop GUI for running a **tool-aware chat UI** against a local **Ollama** model, with optional **MCP (streamable HTTP)** tool integration.

Tech stack:
- **Frontend**: React + TypeScript + Vite
- **Desktop shell**: Tauri (Rust)
- **Backend sidecar**: Python (`python-backend/ollmcp_gui_backend`)

## Prerequisites

- **Node.js + npm** (Homebrew Node works fine)
- **Rust toolchain** (for Tauri): `cargo`, `rustc`
- **Python 3.10+**
- **Ollama** running locally (default: `http://localhost:11434`)

## Install

From the repo root:

```bash
cd ollmcp-desktop-gui
npm install
```

### Python backend dependencies (required for Tauri builds)

The desktop app starts a Python backend process. Create the local venv and install deps:

```bash
cd ollmcp-desktop-gui/python-backend
python3 -m venv .venv
./.venv/bin/python -m pip install -U pip
./.venv/bin/python -m pip install -e .
```

## Run (development)

### Recommended: Tauri dev (desktop app + backend)

```bash
cd ollmcp-desktop-gui
npm run dev:tauri
```

### Web-only (UI in browser; backend features won’t work)

```bash
cd ollmcp-desktop-gui
npm run dev
```

## Build (packaged macOS app)

This produces a `.app` bundle.

```bash
cd ollmcp-desktop-gui
npx tauri build -b app
```

Then run the app bundle (this is the one that shows the correct app icon):

```bash
open "src-tauri/target/release/bundle/macos/Ollmcp Desktop GUI.app"
```

## Using the app

- **Ollama host**: typically `http://localhost:11434`
- **Model**: any model available in Ollama (example: `qwen3.5:4b`)
- **MCP server URL**:
  - a full streamable HTTP endpoint, or
  - a base URL ending with `?token=`/`&token=` (empty) — the token will be appended from keychain
- **Tabs**:
  - **Settings**: configure Ollama + MCP
  - **Tools**: shows tool approvals / tool call activity (when enabled)
  - **Chat**: main chat UI

## Common issues

### Backend shows “starting” / no responses in packaged builds

The packaged `.app` relies on the bundled Python backend and a valid Python environment. If you see backend startup issues:

- Ensure you built the `.app` via `npx tauri build -b app`
- Ensure the Python venv exists at `python-backend/.venv` and deps are installed
- Prefer `npm run dev:tauri` while iterating

### App icon missing

Running the raw binary will not show the Dock icon. Use the `.app` bundle:

```bash
open "src-tauri/target/release/bundle/macos/Ollmcp Desktop GUI.app"
```

## Scripts

From `ollmcp-desktop-gui/`:

- `npm run dev`: Vite dev server
- `npm run dev:tauri`: Tauri desktop dev
- `npm run lint`: ESLint
- `npm run build`: TypeScript build + Vite build
- `npm run build:tauri`: Tauri build (repo script wrapper)

## License

TBD.

<!-- (Template Vite README content removed) -->
