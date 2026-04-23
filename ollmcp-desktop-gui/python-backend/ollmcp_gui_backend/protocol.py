from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Literal, Optional, TypedDict, Union


JsonValue = Any


class GuiToBackendInit(TypedDict):
    type: Literal["init"]
    id: str
    payload: Dict[str, JsonValue]


class GuiToBackendChat(TypedDict):
    type: Literal["chat"]
    id: str
    payload: Dict[str, JsonValue]


class GuiToBackendApproveTool(TypedDict):
    type: Literal["tool_approve"]
    id: str
    payload: Dict[str, JsonValue]

class GuiToBackendCompress(TypedDict):
    type: Literal["compress"]
    id: str
    payload: Dict[str, JsonValue]

GuiToBackendMessage = Union[GuiToBackendInit, GuiToBackendChat, GuiToBackendCompress, GuiToBackendApproveTool]


class BackendToGuiEvent(TypedDict, total=False):
    type: str
    id: str
    requestId: str
    payload: Dict[str, JsonValue]


@dataclass
class PendingToolApproval:
    request_id: str
    tool_call_id: str
    tool_name: str
    server: Optional[str]
    args_json: Any

