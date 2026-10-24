"""Small JSON-RPC client for the local Codex app-server stdio protocol."""

from __future__ import annotations

import json
import queue
import shutil
import subprocess
import threading
from pathlib import Path
from typing import Any


class CodexError(RuntimeError):
    pass


class CodexAppServer:
    def __init__(self, root: Path, skill_path: Path):
        executable = shutil.which("codex")
        if not executable:
            raise CodexError("Codex CLI was not found on PATH.")
        self.root = root
        self.skill_path = skill_path
        self.process = subprocess.Popen(
            [executable, "app-server", "--listen", "stdio://"],
            cwd=root,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self._write_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._next_id = 0
        self._pending: dict[int, queue.Queue[dict[str, Any]]] = {}
        self._listeners: dict[str, set[queue.Queue[dict[str, Any]]]] = {}
        self._resumed_threads: set[str] = set()
        self._last_error = ""
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()
        try:
            self.request(
                "initialize",
                {
                    "clientInfo": {
                        "name": "learn-study-dashboard",
                        "title": "Learn Study Dashboard",
                        "version": "1.0.0",
                    }
                },
                timeout=30,
            )
            self.notify("initialized", {})
        except Exception:
            self.close()
            raise

    def _read_stdout(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "id" in message:
                with self._state_lock:
                    pending = self._pending.get(message["id"])
                if pending:
                    pending.put(message)
                continue
            method = message.get("method")
            params = message.get("params", {})
            thread_id = params.get("threadId") or params.get("thread", {}).get("id")
            if thread_id:
                with self._state_lock:
                    listeners = list(self._listeners.get(thread_id, set()))
                for listener in listeners:
                    listener.put(message)

    def _read_stderr(self) -> None:
        assert self.process.stderr is not None
        for line in self.process.stderr:
            if line.strip():
                self._last_error = line.strip()[-1000:]

    def _send(self, message: dict[str, Any]) -> None:
        if self.process.poll() is not None:
            details = f" {self._last_error}" if self._last_error else ""
            raise CodexError(f"Codex app-server is not running.{details}")
        assert self.process.stdin is not None
        with self._write_lock:
            self.process.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
            self.process.stdin.flush()

    def request(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        timeout: float = 45,
    ) -> dict[str, Any]:
        with self._state_lock:
            self._next_id += 1
            request_id = self._next_id
            response_queue: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=1)
            self._pending[request_id] = response_queue
        try:
            self._send({"id": request_id, "method": method, "params": params or {}})
            response = response_queue.get(timeout=timeout)
        except queue.Empty as error:
            raise CodexError(f"Timed out waiting for Codex method {method!r}.") from error
        finally:
            with self._state_lock:
                self._pending.pop(request_id, None)
        if "error" in response:
            details = response["error"].get("message", "Codex request failed.")
            raise CodexError(str(details))
        return response.get("result", {})

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        self._send({"method": method, "params": params or {}})

    def account_status(self) -> dict[str, Any]:
        result = self.request("account/read", {"refreshToken": True})
        account = result.get("account") or {}
        return {
            "authenticated": account.get("type") == "chatgpt",
            "provider": account.get("type"),
            "plan": account.get("planType"),
            "requires_auth": bool(result.get("requiresOpenaiAuth")),
        }

    def start_chatgpt_login(self) -> dict[str, Any]:
        return self.request(
            "account/login/start",
            {
                "type": "chatgpt",
                "useHostedLoginSuccessPage": True,
                "appBrand": "codex",
            },
        )

    def subscribe(self, thread_id: str) -> queue.Queue[dict[str, Any]]:
        listener: queue.Queue[dict[str, Any]] = queue.Queue()
        with self._state_lock:
            self._listeners.setdefault(thread_id, set()).add(listener)
        return listener

    def unsubscribe(self, thread_id: str, listener: queue.Queue[dict[str, Any]]) -> None:
        with self._state_lock:
            self._listeners.get(thread_id, set()).discard(listener)

    def ensure_thread(self, thread_id: str | None) -> str:
        if thread_id and thread_id not in self._resumed_threads:
            try:
                self.request("thread/resume", {"threadId": thread_id})
                self._resumed_threads.add(thread_id)
                return thread_id
            except CodexError:
                thread_id = None
        if thread_id:
            return thread_id
        result = self.request(
            "thread/start",
            {
                "cwd": str(self.root),
                "serviceName": "learn-study-dashboard",
                "sandbox": "read-only",
            },
        )
        thread = result.get("thread", {})
        new_id = thread.get("id")
        if not new_id:
            raise CodexError("Codex did not return a conversation ID.")
        self._resumed_threads.add(new_id)
        return str(new_id)

    def start_turn(
        self,
        thread_id: str,
        text: str,
        include_skill: bool,
        image_url: str | None = None,
    ) -> tuple[str, queue.Queue[dict[str, Any]]]:
        listener = self.subscribe(thread_id)
        items: list[dict[str, Any]] = [{"type": "text", "text": text}]
        if image_url:
            items.append({"type": "image", "url": image_url, "detail": "high"})
        if include_skill:
            items[0]["text"] = "$study-coach " + text
            items.append(
                {
                    "type": "skill",
                    "name": "study-coach",
                    "path": str(self.skill_path),
                }
            )
        try:
            result = self.request("turn/start", {"threadId": thread_id, "input": items})
        except Exception:
            self.unsubscribe(thread_id, listener)
            raise
        turn_id = result.get("turn", {}).get("id")
        if not turn_id:
            self.unsubscribe(thread_id, listener)
            raise CodexError("Codex did not return a turn ID.")
        return str(turn_id), listener

    def close(self) -> None:
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()

