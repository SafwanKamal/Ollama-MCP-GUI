from __future__ import annotations

import asyncio
import builtins
import json
import sys
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from .protocol import BackendToGuiEvent, PendingToolApproval

_BaseExceptionGroup = getattr(builtins, "BaseExceptionGroup", None)


def _flatten_exception_group(exc: BaseException) -> List[BaseException]:
    """Unwrap nested ExceptionGroup from anyio/MCP TaskGroups (Python 3.11+)."""
    if _BaseExceptionGroup is not None and isinstance(exc, _BaseExceptionGroup):
        out: List[BaseException] = []
        for sub in exc.exceptions:
            out.extend(_flatten_exception_group(sub))
        return out
    return [exc]


def _format_wrapped_http_failures(
    leaves: List[BaseException], ollama_host: str
) -> Tuple[str, str]:
    """Build a short GUI message and full traceback text from flattened TaskGroup errors."""
    details = "".join(
        "".join(traceback.format_exception(type(leaf), leaf, leaf.__traceback__))
        for leaf in leaves
    )
    for leaf in leaves:
        if isinstance(leaf, RuntimeError):
            return str(leaf), details

    parts: List[str] = []
    for leaf in leaves:
        if isinstance(leaf, httpx.ConnectError):
            parts.append(
                "Could not open a network connection (ConnectError). "
                f"If the failure is from Ollama, start Ollama or fix the host in settings (currently {ollama_host!r}). "
                "If it is from your MCP server, verify the MCP URL and network access."
            )
        elif isinstance(leaf, httpx.TimeoutException):
            parts.append(f"A request timed out: {leaf!s}")
        elif isinstance(leaf, httpx.HTTPStatusError):
            parts.append(f"HTTP {leaf.response.status_code}: {leaf!s}")
        else:
            parts.append(f"{type(leaf).__name__}: {leaf}")
    short = parts[0] if parts else "Request failed."
    if len(parts) > 1:
        short = f"{short} — also: {'; '.join(parts[1:3])}"
    return short, details


class JsonlChannel:
    def __init__(self) -> None:
        self._write_lock = threading.Lock()

    def emit(self, event: BackendToGuiEvent) -> None:
        data = json.dumps(event, ensure_ascii=False)
        with self._write_lock:
            sys.stdout.write(data + "\n")
            sys.stdout.flush()


class BackendApp:
    """
    Minimal sidecar skeleton:
    - reads line-delimited JSON messages from stdin
    - emits line-delimited JSON events to stdout

    The real MCP+Ollama wiring is implemented in the next todo.
    """

    def __init__(self) -> None:
        self.ch = JsonlChannel()
        self._pending: Dict[str, "_ApprovalGate"] = {}
        self._pending_lock = threading.Lock()

    def _evt_id(self) -> str:
        return f"evt_{uuid.uuid4().hex}"

    def _emit_status(self, request_id: str, state: str, message: str) -> None:
        self.ch.emit(
            {
                "type": "status",
                "id": self._evt_id(),
                "requestId": request_id,
                "payload": {"state": state, "message": message},
            }
        )

    def handle_init(self, request_id: str, payload: Dict[str, Any]) -> None:
        self.ch.emit(
            {
                "type": "status",
                "id": self._evt_id(),
                "requestId": request_id,
                "payload": {
                    "state": "ready",
                    "message": "Backend initialized.",
                    "capabilities": {
                        "streaming": True,
                        "toolEvents": True,
                        "hil": True,
                    },
                },
            }
        )

    def handle_chat(self, request_id: str, payload: Dict[str, Any]) -> None:
        t = threading.Thread(
            target=lambda: asyncio.run(self._handle_chat_async(request_id, payload)),
            daemon=True,
        )
        t.start()

    def handle_compress(self, request_id: str, payload: Dict[str, Any]) -> None:
        t = threading.Thread(
            target=lambda: asyncio.run(self._handle_compress_async(request_id, payload)),
            daemon=True,
        )
        t.start()

    def handle_tool_approve(self, request_id: str, payload: Dict[str, Any]) -> None:
        approval_id = str(payload.get("approvalId", ""))
        decision = str(payload.get("decision", ""))
        with self._pending_lock:
            gate = self._pending.get(approval_id)
        if gate is not None:
            gate.decision = decision
            gate.event.set()
        self.ch.emit(
            {
                "type": "tool_approval_recorded",
                "id": self._evt_id(),
                "requestId": request_id,
                "payload": {"approvalId": approval_id, "decision": decision},
            }
        )

    async def _handle_chat_async(self, request_id: str, payload: Dict[str, Any]) -> None:
        user_text = str(payload.get("text", ""))
        model = str(payload.get("model", "qwen3.5:4b"))
        ollama_host = str(payload.get("ollamaHost", "http://localhost:11434")).rstrip("/")
        mcp_url = str(
            payload.get("mcpServerUrl") or payload.get("zapierMcpServerUrl", "")
        ).strip()
        hil_enabled = bool(payload.get("hilEnabled", True))
        agent_mode = bool(payload.get("agentMode", False))
        agent_max_steps = int(payload.get("agentMaxSteps", 8) or 8)

        if not mcp_url:
            self.ch.emit(
                {
                    "type": "error",
                    "id": self._evt_id(),
                    "requestId": request_id,
                    "payload": {"message": "Missing MCP server URL (mcpServerUrl)."},
                }
            )
            return

        self._emit_status(request_id, "connecting", "Connecting to MCP…")
        try:
            async with streamable_http_client(mcp_url) as (read_stream, write_stream, _session_info):
                async with ClientSession(read_stream, write_stream) as session:
                    await session.initialize()
                    tools_list = await session.list_tools()
                    ollama_tools = _mcp_tools_to_ollama_tools(tools_list.tools)

                    self.ch.emit(
                        {
                            "type": "tools_list",
                            "id": self._evt_id(),
                            "requestId": request_id,
                            "payload": {
                                "count": len(ollama_tools),
                                "tools": [t["function"]["name"] for t in ollama_tools],
                            },
                        }
                    )
                    self._emit_status(request_id, "ready", "Connected.")

                    history = payload.get("history")
                    messages: List[Dict[str, Any]] = []
                    if isinstance(history, list):
                        for m in history:
                            if not isinstance(m, dict):
                                continue
                            role = str(m.get("role", ""))
                            content = m.get("content")
                            if role and isinstance(content, (str, type(None))):
                                messages.append({"role": role, "content": content})
                    else:
                        messages = [{"role": "user", "content": user_text}]
                    # Ensure the current user message is the last turn (avoid duplicates if frontend included it).
                    if not messages or messages[-1].get("role") != "user" or messages[-1].get("content") != user_text:
                        messages.append({"role": "user", "content": user_text})

                    self.ch.emit(
                        {
                            "type": "status",
                            "id": self._evt_id(),
                            "requestId": request_id,
                            "payload": {
                                "state": "ready",
                                "message": f"Context: {len(messages)} messages",
                            },
                        }
                    )
                    selected_tools = _select_tools_for_query(ollama_tools, user_text, max_tools=40)
                    self.ch.emit(
                        {
                            "type": "status",
                            "id": self._evt_id(),
                            "requestId": request_id,
                            "payload": {
                                "state": "ready",
                                "message": f"Tool context: {len(selected_tools)}/{len(ollama_tools)} tools",
                            },
                        }
                    )

                    # Even with agent_mode off, allow a small loop so tool-using queries
                    # can complete (tool_call -> tool_result -> final answer).
                    max_steps = agent_max_steps if agent_mode else 3
                    steps = 0
                    while steps < max_steps:
                        steps += 1
                        assistant_message, tool_calls = await _ollama_chat_stream(
                            self.ch,
                            request_id,
                            ollama_host,
                            model,
                            messages,
                            selected_tools,
                        )

                        messages.append(assistant_message)
                        if not tool_calls:
                            break

                        if steps >= max_steps:
                            self.ch.emit(
                                {
                                    "type": "error",
                                    "id": self._evt_id(),
                                    "requestId": request_id,
                                    "payload": {
                                        "message": f"Loop limit reached ({max_steps}). Enable Agent mode to allow more tool steps.",
                                    },
                                }
                            )
                            break

                        # Execute tool calls (sequential). Zapier servers often expose many tools; the model chooses.
                        for idx, call in enumerate(tool_calls):
                            tool_name, args = _extract_tool_call(call)
                            approval_id = f"approval_{self._evt_id()}_{idx}"

                            if hil_enabled:
                                gate = _ApprovalGate()
                                with self._pending_lock:
                                    self._pending[approval_id] = gate
                                self.ch.emit(
                                    {
                                        "type": "tool_call_pending",
                                        "id": self._evt_id(),
                                        "requestId": request_id,
                                        "payload": {
                                            "approvalId": approval_id,
                                            "toolName": tool_name,
                                            "args": args,
                                        },
                                    }
                                )
                                decision = await gate.wait(timeout_s=120.0)
                                with self._pending_lock:
                                    self._pending.pop(approval_id, None)
                                if decision != "approve":
                                    self.ch.emit(
                                        {
                                            "type": "tool_call_denied",
                                            "id": self._evt_id(),
                                            "requestId": request_id,
                                            "payload": {
                                                "approvalId": approval_id,
                                                "toolName": tool_name,
                                            },
                                        }
                                    )
                                    messages.append(
                                        {
                                            "role": "tool",
                                            "tool_name": tool_name,
                                            "content": "Tool execution denied by user.",
                                        }
                                    )
                                    continue

                            self.ch.emit(
                                {
                                    "type": "tool_call_started",
                                    "id": self._evt_id(),
                                    "requestId": request_id,
                                    "payload": {
                                        "approvalId": approval_id,
                                        "toolName": tool_name,
                                        "args": args,
                                    },
                                }
                            )
                            try:
                                result = await session.call_tool(tool_name, arguments=args)
                                text = _tool_result_to_text(result)
                                self.ch.emit(
                                    {
                                        "type": "tool_call_result",
                                        "id": self._evt_id(),
                                        "requestId": request_id,
                                        "payload": {
                                            "approvalId": approval_id,
                                            "toolName": tool_name,
                                            "result": text,
                                        },
                                    }
                                )
                                messages.append(
                                    {
                                        "role": "tool",
                                        "tool_name": tool_name,
                                        "content": text,
                                    }
                                )
                            except Exception as e:  # noqa: BLE001
                                self.ch.emit(
                                    {
                                        "type": "tool_call_error",
                                        "id": self._evt_id(),
                                        "requestId": request_id,
                                        "payload": {
                                            "approvalId": approval_id,
                                            "toolName": tool_name,
                                            "error": str(e),
                                        },
                                    }
                                )
                                messages.append(
                                    {
                                        "role": "tool",
                                        "tool_name": tool_name,
                                        "content": f"Tool error: {e}",
                                    }
                                )
                        # Continue loop so the model can incorporate tool results (and possibly request another tool).
                        continue

        except httpx.HTTPStatusError as e:
            # Avoid leaking tokens in URLs in error messages.
            msg = f"MCP request failed: HTTP {e.response.status_code}"
            details = f"{e}\n"
            self.ch.emit(
                {
                    "type": "error",
                    "id": self._evt_id(),
                    "requestId": request_id,
                    "payload": {"message": msg, "details": details},
                }
            )
        except Exception as e:  # noqa: BLE001
            # Python 3.11+ may wrap errors in an ExceptionGroup from anyio/taskgroups.
            leaves = _flatten_exception_group(e)
            if len(leaves) > 1:
                msg, details = _format_wrapped_http_failures(leaves, ollama_host)
                self.ch.emit(
                    {
                        "type": "error",
                        "id": self._evt_id(),
                        "requestId": request_id,
                        "payload": {
                            "message": msg,
                            "details": details,
                        },
                    }
                )
                sys.stderr.write(details + "\n")
                sys.stderr.flush()
                return

            # Single exception path (old behavior)
            details = "".join(traceback.format_exception(type(e), e, e.__traceback__))
            self.ch.emit(
                {
                    "type": "error",
                    "id": self._evt_id(),
                    "requestId": request_id,
                    "payload": {"message": str(e), "details": details},
                }
            )
            sys.stderr.write(details + "\n")
            sys.stderr.flush()
        finally:
            self.ch.emit(
                {
                    "type": "assistant_done",
                    "id": self._evt_id(),
                    "requestId": request_id,
                    "payload": {},
                }
            )

    def dispatch(self, msg: Dict[str, Any]) -> None:
        msg_type = msg.get("type")
        request_id = str(msg.get("id", ""))
        payload = msg.get("payload") or {}
        if not isinstance(payload, dict):
            payload = {"value": payload}

        if msg_type == "init":
            self.handle_init(request_id, payload)
        elif msg_type == "chat":
            self.handle_chat(request_id, payload)
        elif msg_type == "compress":
            self.handle_compress(request_id, payload)
        elif msg_type == "tool_approve":
            self.handle_tool_approve(request_id, payload)
        else:
            self.ch.emit(
                {
                    "type": "error",
                    "id": f"evt_{int(time.time() * 1000)}",
                    "requestId": request_id,
                    "payload": {
                        "message": f"Unknown message type: {msg_type}",
                        "raw": msg,
                    },
                }
            )

    async def _handle_compress_async(self, request_id: str, payload: Dict[str, Any]) -> None:
        """
        Creates a compact "memory" summary of the conversation so far.
        Frontend will store it and only send the summary + newer messages afterwards.
        """
        model = str(payload.get("model", "qwen3.5:4b"))
        ollama_host = str(payload.get("ollamaHost", "http://localhost:11434")).rstrip("/")
        memory_summary = str(payload.get("memorySummary", "") or "")
        cutoff_ms = int(payload.get("cutoffMs", 0) or 0)
        history = payload.get("history") or []

        def fmt_turn(role: str, content: str) -> str:
            return f"{role.upper()}: {content}".strip()

        turns: List[str] = []
        if memory_summary.strip():
            turns.append("MEMORY_SO_FAR:\n" + memory_summary.strip())

        if isinstance(history, list):
            for m in history:
                if not isinstance(m, dict):
                    continue
                created = int(m.get("createdAtMs", 0) or 0)
                if cutoff_ms and created > cutoff_ms:
                    continue
                role = str(m.get("role", "") or "")
                content = m.get("content")
                if not role or not isinstance(content, str) or not content.strip():
                    continue
                turns.append(fmt_turn(role, content.strip()))

        prompt = (
            "You are compressing chat history for a local LLM app.\n"
            "Return a compact memory summary that preserves: user goals, preferences, settings, decisions, "
            "important facts, and any unfinished tasks.\n"
            "Constraints:\n"
            "- Be concise but specific.\n"
            "- Use bullet points.\n"
            "- Do NOT include verbatim long excerpts.\n"
            "- Do NOT invent facts.\n"
            "- Output ONLY the summary.\n\n"
            "CHAT_HISTORY:\n"
            + "\n".join(turns)
        )

        try:
            self._emit_status(request_id, "working", "Compressing context…")
            summary = await _ollama_summarize(ollama_host, model, prompt)
            self.ch.emit(
                {
                    "type": "context_compressed",
                    "id": self._evt_id(),
                    "requestId": request_id,
                    "payload": {"memorySummary": summary, "memoryCutoffMs": cutoff_ms},
                }
            )
        except Exception as e:  # noqa: BLE001
            details = "".join(traceback.format_exception(type(e), e, e.__traceback__))
            self.ch.emit(
                {
                    "type": "error",
                    "id": self._evt_id(),
                    "requestId": request_id,
                    "payload": {"message": str(e), "details": details},
                }
            )
        finally:
            self.ch.emit(
                {
                    "type": "assistant_done",
                    "id": self._evt_id(),
                    "requestId": request_id,
                    "payload": {},
                }
            )


def main() -> None:
    app = BackendApp()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception as e:  # noqa: BLE001
            app.ch.emit(
                {
                    "type": "error",
                    "id": f"evt_{int(time.time() * 1000)}",
                    "requestId": "",
                    "payload": {"message": f"Invalid JSON: {e}", "raw": line},
                }
            )
            continue
        if isinstance(msg, dict):
            app.dispatch(msg)
        else:
            app.ch.emit(
                {
                    "type": "error",
                    "id": f"evt_{int(time.time() * 1000)}",
                    "requestId": "",
                    "payload": {"message": "Expected JSON object", "raw": msg},
                }
            )


@dataclass
class _ApprovalGate:
    event: threading.Event = field(default_factory=threading.Event)
    decision: Optional[str] = None

    async def wait(self, timeout_s: float) -> str:
        loop = asyncio.get_running_loop()
        ok = await loop.run_in_executor(None, self.event.wait, timeout_s)
        if not ok:
            return "deny"
        return self.decision or "deny"


def _mcp_tools_to_ollama_tools(tools: List[Any]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for t in tools:
        # `t` is mcp.types.Tool; but keep this robust.
        name = getattr(t, "name", None) or t.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        desc = getattr(t, "description", None) or t.get("description") or ""
        schema = getattr(t, "inputSchema", None) or t.get("inputSchema") or {"type": "object"}
        out.append(
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": desc,
                    "parameters": schema,
                },
            }
        )
    return out


async def _ollama_chat_stream(
    ch: JsonlChannel,
    request_id: str,
    host: str,
    model: str,
    messages: List[Dict[str, Any]],
    tools: List[Dict[str, Any]],
) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    url = f"{host}/api/chat"
    body = {"model": model, "messages": messages, "tools": tools, "stream": True}

    tool_calls: List[Dict[str, Any]] = []
    assistant_content: List[str] = []
    assistant_tool_calls: Optional[List[Dict[str, Any]]] = None

    try:
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("POST", url, json=body) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    chunk = json.loads(line)
                    msg = chunk.get("message") or {}
                    delta = msg.get("content")
                    if delta:
                        assistant_content.append(delta)
                        ch.emit(
                            {
                                "type": "assistant_delta",
                                "id": f"evt_{int(time.time() * 1000)}",
                                "requestId": request_id,
                                "payload": {"delta": delta},
                            }
                        )
                    if msg.get("tool_calls"):
                        # Ollama typically provides tool_calls on final-ish chunk; keep latest.
                        assistant_tool_calls = msg.get("tool_calls")
                    if chunk.get("done"):
                        break
    except httpx.ConnectError as e:
        raise RuntimeError(
            f"Cannot connect to Ollama at {host!r} ({url}). "
            "Start the Ollama app (or `ollama serve`) and confirm the Ollama host in app settings."
        ) from e
    except httpx.TimeoutException as e:
        raise RuntimeError(f"Ollama request timed out ({url}).") from e
    except httpx.HTTPStatusError as e:
        raise RuntimeError(f"Ollama returned HTTP {e.response.status_code} for {url}.") from e
    except httpx.RemoteProtocolError as e:
        raise RuntimeError(
            "Ollama disconnected while processing the request. This often happens when the tool list is too large. "
            "Try a more specific query or reduce tool context."
        ) from e

    tool_calls = assistant_tool_calls or []
    assistant_message: Dict[str, Any] = {
        "role": "assistant",
        "content": "".join(assistant_content),
    }
    if tool_calls:
        assistant_message["tool_calls"] = tool_calls
        # Avoid empty-string content issues in some templates by using null when no content.
        if assistant_message["content"] == "":
            assistant_message["content"] = None

    return assistant_message, tool_calls


async def _ollama_summarize(host: str, model: str, prompt: str) -> str:
    """
    Non-streaming single-shot call used for context compression.
    """
    url = f"{host}/api/chat"
    body = {
        "model": model,
        "stream": False,
        "messages": [
            {"role": "system", "content": "You are a precise summarizer."},
            {"role": "user", "content": prompt},
        ],
    }
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(url, json=body)
            resp.raise_for_status()
            data = resp.json()
            msg = data.get("message") or {}
            content = msg.get("content")
            if isinstance(content, str) and content.strip():
                return content.strip()
            return json.dumps(data, ensure_ascii=False)[:2000]
    except httpx.ConnectError as e:
        raise RuntimeError(
            f"Cannot connect to Ollama at {host!r} ({url}). Start Ollama and retry compression."
        ) from e


def _extract_tool_call(call: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
    fn = call.get("function") or {}
    name = fn.get("name") or ""
    args = fn.get("arguments") or {}
    if not isinstance(args, dict):
        # Some layers stringify; best-effort parse.
        try:
            args = json.loads(args)
        except Exception:  # noqa: BLE001
            args = {"arguments": args}
    return name, args


def _tool_result_to_text(result: Any) -> str:
    # mcp tool result has `.content` list with `type`/`text`.
    content = getattr(result, "content", None)
    if content is None and isinstance(result, dict):
        content = result.get("content")
    if not content:
        try:
            return json.dumps(result, ensure_ascii=False, default=str)
        except Exception:  # noqa: BLE001
            return str(result)
    parts: List[str] = []
    for item in content:
        text = getattr(item, "text", None) or item.get("text")
        if text:
            parts.append(str(text))
        else:
            parts.append(json.dumps(item, ensure_ascii=False))
    return "\n".join(parts)


def _select_tools_for_query(
    tools: List[Dict[str, Any]], query: str, max_tools: int
) -> List[Dict[str, Any]]:
    """
    Zapier MCP can expose a huge tool set; sending all schemas to Ollama can overwhelm it.
    We do a simple lexical ranking to select a relevant subset.
    """
    q = (query or "").lower()
    tokens = [t for t in q.replace("/", " ").replace("_", " ").split() if len(t) >= 3]

    def score(t: Dict[str, Any]) -> int:
        fn = (t.get("function") or {}) if isinstance(t, dict) else {}
        name = str(fn.get("name", "")).lower()
        desc = str(fn.get("description", "")).lower()
        s = 0
        for tok in tokens:
            if tok in name:
                s += 8
            if tok in desc:
                s += 3
        if any(k in name for k in ("list", "search", "get")):
            s += 1
        return s

    ranked = sorted(tools, key=score, reverse=True)
    picked = ranked[: max(1, max_tools)]
    # Ensure deterministic output if all scores are zero: keep first N.
    return picked


if __name__ == "__main__":
    main()


