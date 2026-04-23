#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
  fs::{create_dir_all, File, OpenOptions},
  io::{BufRead, BufReader, Write},
  path::{Path, PathBuf},
  process::{Child, ChildStdin, Command, Stdio},
  sync::{Arc, Mutex},
  thread,
  time::{SystemTime, UNIX_EPOCH},
};

use tauri::{Emitter, Manager, State};
use uuid::Uuid;

#[derive(Default)]
struct BackendState {
  child: Option<Child>,
  stdin: Option<Arc<Mutex<ChildStdin>>>,
}

#[derive(Default)]
struct HostLogState {
  file: Mutex<Option<File>>,
  path: Mutex<Option<PathBuf>>,
}

fn ts_ms() -> u128 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis())
    .unwrap_or(0)
}

fn host_log_write(app: &tauri::AppHandle, line: &str) {
  if let Some(st) = app.try_state::<Arc<HostLogState>>() {
    let mut guard = st.file.lock().ok();
    if let Some(Some(f)) = guard.as_deref_mut() {
      let _ = writeln!(f, "[{}] {}", ts_ms(), line);
      let _ = f.flush();
    }
  }
}

fn emit_backend_event(app: &tauri::AppHandle, line: &str) {
  // Forward raw JSON line to the frontend; the UI parses it.
  host_log_write(app, &format!("emit backend:event {}", line));
  let _ = app.emit("backend:event", line.to_string());
}

fn resolve_backend_root(app: &tauri::AppHandle) -> Option<PathBuf> {
  // Release builds: the app runs from a `.app` bundle and `cwd` is not stable.
  // Prefer resources if bundled.
  if let Ok(resource_dir) = app.path().resource_dir() {
    // Option A: resources include the whole `python-backend/` folder.
    let p = resource_dir.join("python-backend");
    if p.join("ollmcp_gui_backend").exists() {
      return Some(p);
    }

    // Some bundlers place resources under an internal `_up_` directory.
    let p_up = resource_dir.join("_up_").join("python-backend");
    if p_up.join("ollmcp_gui_backend").exists() {
      return Some(p_up);
    }

    // Option B: resources include only `ollmcp_gui_backend/` at the root.
    if resource_dir.join("ollmcp_gui_backend").exists() {
      return Some(resource_dir);
    }

    // Or under `_up_`.
    let up = resource_dir.join("_up_");
    if up.join("ollmcp_gui_backend").exists() {
      return Some(up);
    }
  }

  // Dev builds: when running `tauri dev`, `cwd` is typically `src-tauri`.
  // Keep this fallback for local development workflows.
  let dev = PathBuf::from("../python-backend");
  if dev.exists() {
    return Some(dev);
  }

  None
}

fn resolve_backend_python(backend_root: Option<&Path>) -> PathBuf {
  // GUI apps on macOS typically do NOT inherit the user's shell PATH.
  // Prefer absolute paths when possible.
  let mut candidates: Vec<PathBuf> = vec![];

  if let Some(root) = backend_root {
    candidates.push(root.join(".venv/bin/python3"));
    candidates.push(root.join(".venv/bin/python"));
  }

  // System fallbacks (best-effort).
  candidates.push(PathBuf::from("/usr/bin/python3"));
  candidates.push(PathBuf::from("/usr/local/bin/python3"));
  candidates.push(PathBuf::from("/opt/homebrew/bin/python3"));
  candidates.push(PathBuf::from("python3"));
  candidates.push(PathBuf::from("python"));

  for c in candidates {
    // For absolute/relative-with-separators, only accept if it exists.
    // For bare commands (python3/python) we'll attempt spawn.
    let has_sep = c.components().count() > 1;
    if has_sep {
      if c.exists() {
        return c;
      }
      continue;
    }
    return c;
  }

  PathBuf::from("python3")
}

#[tauri::command]
fn backend_start(app: tauri::AppHandle, state: State<'_, Arc<Mutex<BackendState>>>) -> Result<(), String> {
  host_log_write(&app, "backend_start invoked");
  let mut st = state.lock().map_err(|_| "state lock poisoned")?;
  if st.child.is_some() {
    host_log_write(&app, "backend already running; backend_start no-op");
    return Ok(());
  }

  let backend_root = resolve_backend_root(&app);
  let python = resolve_backend_python(backend_root.as_deref());

  // Emit launch diagnostics (useful for release builds where PATH/cwd differ).
  let launch_diag = serde_json::json!({
    "type": "backend_launch",
    "id": format!("evt_{}", Uuid::new_v4()),
    "payload": {
      "python": python.display().to_string(),
      "backendRoot": backend_root.as_ref().map(|p| p.display().to_string()),
      "cwd": std::env::current_dir().ok().map(|p| p.display().to_string())
    }
  });
  host_log_write(
    &app,
    &format!(
      "backend_launch python={} root={:?}",
      python.display(),
      backend_root.as_ref().map(|p| p.display().to_string())
    ),
  );
  let _ = app.emit("backend:event", launch_diag.to_string());

  let mut cmd = Command::new(&python);
  if let Some(root) = backend_root.as_deref() {
    cmd.current_dir(root);
    // Ensure `python -m ollmcp_gui_backend.main` can import the package even if not installed globally.
    cmd.env("PYTHONPATH", root.to_string_lossy().to_string());
  }
  cmd.env("PYTHONUNBUFFERED", "1");

  let mut child = cmd
    .args(["-m", "ollmcp_gui_backend.main"])
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|e| {
      let cwd = std::env::current_dir()
        .ok()
        .and_then(|p| p.to_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "<unknown>".to_string());
      let root = backend_root
        .as_ref()
        .and_then(|p| p.to_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "<none>".to_string());
      format!(
        "failed to start backend: {e}\npython: {}\nbackend_root: {root}\ncwd: {cwd}",
        python.display()
      )
    })?;

  let stdin = child.stdin.take().ok_or("backend stdin unavailable")?;
  let stdout = child.stdout.take().ok_or("backend stdout unavailable")?;
  let stderr = child.stderr.take().ok_or("backend stderr unavailable")?;

  let stdin_arc = Arc::new(Mutex::new(stdin));
  st.stdin = Some(stdin_arc.clone());
  st.child = Some(child);

  let app_for_thread = app.clone();
  thread::spawn(move || {
    let reader = BufReader::new(stdout);
    for line in reader.lines().flatten() {
      emit_backend_event(&app_for_thread, &line);
    }
    host_log_write(&app_for_thread, "backend stdout closed; emitting exited status");
    let _ = app_for_thread.emit("backend:event", r#"{"type":"status","payload":{"state":"exited"}}"#.to_string());
  });

  let app_for_err = app.clone();
  thread::spawn(move || {
    let reader = BufReader::new(stderr);
    for line in reader.lines().flatten() {
      // Wrap stderr lines as structured events so the UI can surface them.
      host_log_write(&app_for_err, &format!("backend stderr: {}", line));
      let payload = serde_json::json!({
        "type": "backend_stderr",
        "id": format!("evt_{}", Uuid::new_v4()),
        "payload": { "line": line }
      });
      let _ = app_for_err.emit("backend:event", payload.to_string());
    }
  });

  // Send init handshake.
  let init_msg = serde_json::json!({
    "type": "init",
    "id": format!("req_{}", Uuid::new_v4()),
    "payload": {}
  });
  drop(st);
  backend_send_raw(state, init_msg.to_string())?;
  Ok(())
}

fn backend_send_raw(state: State<'_, Arc<Mutex<BackendState>>>, raw: String) -> Result<(), String> {
  let st = state.lock().map_err(|_| "state lock poisoned")?;
  let stdin_arc = st.stdin.as_ref().ok_or("backend not started")?.clone();
  drop(st);

  let mut stdin = stdin_arc.lock().map_err(|_| "stdin lock poisoned")?;
  stdin
    .write_all(raw.as_bytes())
    .and_then(|_| stdin.write_all(b"\n"))
    .and_then(|_| stdin.flush())
    .map_err(|e| format!("failed to write to backend: {e}"))?;
  Ok(())
}

#[tauri::command]
fn backend_send(state: State<'_, Arc<Mutex<BackendState>>>, msg: serde_json::Value) -> Result<(), String> {
  backend_send_raw(state, msg.to_string())
}

const KEYRING_SERVICE: &str = "ollmcp-desktop-gui";
const KEY_ZAPIER_TOKEN: &str = "zapier_mcp_token";

#[tauri::command]
fn secret_set_zapier_token(token: String) -> Result<(), String> {
  let entry = keyring::Entry::new(KEYRING_SERVICE, KEY_ZAPIER_TOKEN).map_err(|e| e.to_string())?;
  entry.set_password(&token).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_get_zapier_token() -> Result<Option<String>, String> {
  let entry = keyring::Entry::new(KEYRING_SERVICE, KEY_ZAPIER_TOKEN).map_err(|e| e.to_string())?;
  match entry.get_password() {
    Ok(pw) => {
      if pw.is_empty() {
        Ok(None)
      } else {
        Ok(Some(pw))
      }
    }
    Err(keyring::Error::NoEntry) => Ok(None),
    Err(e) => Err(e.to_string()),
  }
}

#[tauri::command]
fn secret_delete_zapier_token() -> Result<(), String> {
  let entry = keyring::Entry::new(KEYRING_SERVICE, KEY_ZAPIER_TOKEN).map_err(|e| e.to_string())?;
  match entry.delete_credential() {
    Ok(()) => Ok(()),
    Err(keyring::Error::NoEntry) => Ok(()),
    Err(e) => Err(e.to_string()),
  }
}

fn main() {
  tauri::Builder::default()
    .manage(Arc::new(Mutex::new(BackendState::default())))
    .manage(Arc::new(HostLogState::default()))
    .setup(|app| {
      // Optional persistent host log file for debugging release builds.
      // Enable by setting `OLLMCP_DEBUG_LOG=1` in the environment.
      let debug_log_enabled = std::env::var("OLLMCP_DEBUG_LOG")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

      if !debug_log_enabled {
        return Ok(());
      }

      let handle = app.handle();
      let st = handle.state::<Arc<HostLogState>>();
      // Prefer app log dir, but fall back to /tmp if anything fails (packaged apps can have surprising FS constraints).
      let preferred_dir = handle
        .path()
        .app_log_dir()
        .or_else(|_| handle.path().app_data_dir())
        .ok();
      let mut dir = preferred_dir.unwrap_or_else(|| PathBuf::from("/tmp"));
      if create_dir_all(&dir).is_err() {
        dir = PathBuf::from("/tmp");
        let _ = create_dir_all(&dir);
      }
      let path = dir.join(format!("ollmcp_desktop_gui_{}.log", ts_ms()));
      let file = OpenOptions::new().create(true).append(true).open(&path).map_err(|e| e.to_string())?;
      *st.file.lock().map_err(|_| "log lock poisoned")? = Some(file);
      *st.path.lock().map_err(|_| "log lock poisoned")? = Some(path.clone());

      host_log_write(&handle, &format!("host log initialized at {}", path.display()));

      // Tell the frontend where the log file lives.
      let evt = serde_json::json!({
        "type": "host_log_path",
        "id": format!("evt_{}", Uuid::new_v4()),
        "payload": { "path": path.display().to_string() }
      });
      let _ = handle.emit("backend:event", evt.to_string());
      Ok(())
    })
    .plugin(tauri_plugin_shell::init())
    .invoke_handler(tauri::generate_handler![
      backend_start,
      backend_send,
      secret_set_zapier_token,
      secret_get_zapier_token,
      secret_delete_zapier_token
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

