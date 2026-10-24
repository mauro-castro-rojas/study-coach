"""SQLite persistence and readable exports for browser study sessions."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


class StudyStore:
    def __init__(self, root: Path, plan: dict[str, Any]):
        self.root = root
        self.plan = plan
        self.timezone = ZoneInfo(plan["timezone"])
        self.db_path = root / "records" / "study.sqlite3"
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.progress_path = root / "records" / "progress.json"
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        return connection

    def _initialize(self) -> None:
        with self._connect() as db:
            db.execute("PRAGMA journal_mode = WAL")
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    topic_id TEXT NOT NULL,
                    reference_id TEXT NOT NULL,
                    mode TEXT NOT NULL DEFAULT 'lesson',
                    status TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    ended_at TEXT,
                    active_since TEXT,
                    heartbeat_at TEXT,
                    elapsed_seconds INTEGER NOT NULL DEFAULT 0,
                    setup_seconds INTEGER NOT NULL DEFAULT 0,
                    planned_seconds INTEGER,
                    sound_on_target INTEGER NOT NULL DEFAULT 0,
                    start_position TEXT,
                    end_position TEXT,
                    concepts TEXT NOT NULL DEFAULT '',
                    score REAL,
                    grade_notes TEXT NOT NULL DEFAULT '',
                    codex_thread_id TEXT,
                    legacy INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS exercises (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    exercise_id TEXT NOT NULL DEFAULT '',
                    description TEXT NOT NULL DEFAULT '',
                    outcome TEXT NOT NULL,
                    notes TEXT NOT NULL DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
                    content TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS sessions_topic_idx
                    ON sessions(topic_id, reference_id, started_at);
                CREATE INDEX IF NOT EXISTS exercises_session_idx
                    ON exercises(session_id);
                CREATE INDEX IF NOT EXISTS messages_session_idx
                    ON messages(session_id, id);
                """
            )
            session_columns = {row["name"] for row in db.execute("PRAGMA table_info(sessions)")}
            if "sound_on_target" not in session_columns:
                db.execute(
                    "ALTER TABLE sessions ADD COLUMN sound_on_target INTEGER NOT NULL DEFAULT 0"
                )
        self._recover_open_sessions()
        self._import_legacy_events()

    def _now_utc(self) -> datetime:
        return datetime.now(timezone.utc)

    def _now_text(self) -> str:
        return self._now_utc().isoformat(timespec="seconds")

    def local_datetime(self, value: str) -> datetime:
        return datetime.fromisoformat(value).astimezone(self.timezone)

    def _recover_open_sessions(self) -> None:
        with self._connect() as db:
            rows = db.execute(
                "SELECT id, status, active_since, heartbeat_at, elapsed_seconds "
                "FROM sessions WHERE status IN ('active', 'paused')"
            ).fetchall()
            for row in rows:
                elapsed = int(row["elapsed_seconds"])
                if row["status"] == "active" and row["active_since"] and row["heartbeat_at"]:
                    active_since = datetime.fromisoformat(row["active_since"])
                    heartbeat_at = datetime.fromisoformat(row["heartbeat_at"])
                    elapsed += max(0, int((heartbeat_at - active_since).total_seconds()))
                db.execute(
                    "UPDATE sessions SET status='paused', elapsed_seconds=?, "
                    "active_since=NULL, heartbeat_at=NULL WHERE id=?",
                    (elapsed, row["id"]),
                )

    def _references(self) -> dict[str, tuple[str, str, str]]:
        output: dict[str, tuple[str, str, str]] = {}
        for topic_id, topic in self.plan["topics"].items():
            for reference in topic["references"]:
                output[reference["id"]] = (
                    topic_id,
                    topic["title"],
                    reference["kind"],
                )
        return output

    def _import_legacy_events(self) -> None:
        legacy_path = self.root / "records" / "runtime" / "timer-events.jsonl"
        with self._connect() as db:
            if db.execute(
                "SELECT 1 FROM metadata WHERE key='legacy_timer_import_v1'"
            ).fetchone():
                return
            if legacy_path.exists():
                for line in legacy_path.read_text(encoding="utf-8").splitlines():
                    try:
                        event = json.loads(line)
                        started = datetime.fromisoformat(event["started_at"])
                        ended = datetime.fromisoformat(event["ended_at"])
                        topic_id = str(event["subject"])
                        reference_id = event.get("resource") or topic_id
                        if reference_id not in self._references():
                            choices = self.plan["topics"].get(topic_id, {}).get("references", [])
                            reference_id = choices[0]["id"] if choices else "legacy"
                        duration = max(0, int((ended - started).total_seconds()))
                        fingerprint = hashlib.sha256(line.encode("utf-8")).hexdigest()[:20]
                        session_id = f"legacy-{fingerprint}"
                        db.execute(
                            """INSERT OR IGNORE INTO sessions
                               (id, topic_id, reference_id, mode, status, started_at,
                                ended_at, elapsed_seconds, planned_seconds, start_position,
                                end_position, concepts, legacy, created_at)
                               VALUES (?, ?, ?, 'legacy', ?, ?, ?, ?, NULL, '', '', '', 1, ?)""",
                            (
                                session_id,
                                topic_id,
                                reference_id,
                                "completed" if event.get("status") == "completed" else "interrupted",
                                started.isoformat(timespec="seconds"),
                                ended.isoformat(timespec="seconds"),
                                duration,
                                self._now_text(),
                            ),
                        )
                    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                        continue
            db.execute(
                "INSERT INTO metadata(key, value) VALUES('legacy_timer_import_v1', ?) "
                "ON CONFLICT(key) DO NOTHING",
                (self._now_text(),),
            )

    def progress(self) -> dict[str, Any]:
        if self.progress_path.exists():
            return json.loads(self.progress_path.read_text(encoding="utf-8"))
        return {"topics": {}, "resources": {}}

    def _save_progress(self, progress: dict[str, Any]) -> None:
        temporary = self.progress_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(progress, indent=2) + "\n", encoding="utf-8")
        temporary.replace(self.progress_path)

    def list_references(self) -> list[dict[str, Any]]:
        saved = self.progress()
        result: list[dict[str, Any]] = []
        for topic_id, topic in self.plan["topics"].items():
            for reference in topic["references"]:
                if reference["kind"] == "book":
                    cursor = saved.get("topics", {}).get(topic_id, {}).get("next_pdf_page")
                    route = f"/reference/{reference['id']}#page={cursor or 1}"
                    source_path = reference["path"]
                    available = (self.root / source_path).is_file()
                    progress_label = f"PDF page {cursor}" if cursor else "Page not set"
                else:
                    seconds = int(
                        saved.get("resources", {}).get(reference["id"], {}).get("last_seconds", 0)
                    )
                    route = f"/reference/{reference['id']}"
                    source_path = ""
                    available = bool(reference.get("url"))
                    progress_label = f"Video {seconds // 60:02d}:{seconds % 60:02d}"
                result.append(
                    {
                        "id": reference["id"],
                        "topic_id": topic_id,
                        "topic_title": topic["title"],
                        "title": reference["title"],
                        "kind": reference["kind"],
                        "default_minutes": reference["default_minutes"],
                        "url": reference.get("url"),
                        "route": route,
                        "available": available,
                        "progress": progress_label,
                    }
                )
        return result

    def topics(self) -> list[dict[str, Any]]:
        refs = self.list_references()
        by_topic: dict[str, list[dict[str, Any]]] = {}
        for reference in refs:
            by_topic.setdefault(reference["topic_id"], []).append(reference)
        return [
            {"id": topic_id, "title": topic["title"], "references": by_topic[topic_id]}
            for topic_id, topic in self.plan["topics"].items()
        ]

    def start_session(
        self,
        topic_id: str,
        reference_id: str,
        planned_seconds: int | None,
        start_position: str,
        mode: str = "lesson",
        setup_seconds: int = 0,
        sound_on_target: bool = False,
    ) -> dict[str, Any]:
        references = self._references()
        if reference_id not in references or references[reference_id][0] != topic_id:
            raise ValueError("That reference does not belong to the selected topic.")
        if mode not in {"lesson", "assessment"}:
            raise ValueError("Unknown session mode.")
        with self._connect() as db:
            if db.execute(
                "SELECT 1 FROM sessions WHERE status IN ('active','paused') LIMIT 1"
            ).fetchone():
                raise ValueError("Finish or resume the current session before starting another.")
            session_id = uuid.uuid4().hex
            now = self._now_text()
            db.execute(
                """INSERT INTO sessions
                   (id, topic_id, reference_id, mode, status, started_at, active_since,
                    heartbeat_at, elapsed_seconds, setup_seconds, planned_seconds, sound_on_target,
                    start_position, created_at)
                   VALUES (?, ?, ?, ?, 'active', ?, ?, ?, 0, ?, ?, ?, ?, ?)""",
                (
                    session_id,
                    topic_id,
                    reference_id,
                    mode,
                    now,
                    now,
                    now,
                    max(0, int(setup_seconds)),
                    planned_seconds,
                    int(sound_on_target),
                    start_position,
                    now,
                ),
            )
        self._write_start_cursor(topic_id, reference_id, start_position)
        return self.session(session_id)

    def _write_start_cursor(self, topic_id: str, reference_id: str, position: str) -> None:
        if not position:
            return
        progress = self.progress()
        if self._references()[reference_id][2] == "book":
            progress.setdefault("topics", {}).setdefault(topic_id, {})["next_pdf_page"] = int(position)
        else:
            progress.setdefault("resources", {}).setdefault(reference_id, {})[
                "last_seconds"
            ] = self._position_seconds(position)
        self._save_progress(progress)

    @staticmethod
    def _position_seconds(value: str) -> int:
        parts = value.split(":")
        if len(parts) != 2:
            raise ValueError("Video position must use MM:SS.")
        minutes, seconds = (int(part) for part in parts)
        if minutes < 0 or not 0 <= seconds < 60:
            raise ValueError("Video position must use MM:SS.")
        return minutes * 60 + seconds

    def _add_elapsed(self, db: sqlite3.Connection, session_id: str, ended_at: str) -> None:
        row = db.execute(
            "SELECT elapsed_seconds, active_since FROM sessions WHERE id=?", (session_id,)
        ).fetchone()
        if not row:
            raise ValueError("Session not found.")
        elapsed = int(row["elapsed_seconds"])
        if row["active_since"]:
            active_since = datetime.fromisoformat(row["active_since"])
            end_dt = datetime.fromisoformat(ended_at)
            elapsed += max(0, int((end_dt - active_since).total_seconds()))
        db.execute(
            "UPDATE sessions SET elapsed_seconds=?, active_since=NULL, heartbeat_at=NULL "
            "WHERE id=?",
            (elapsed, session_id),
        )

    def heartbeat(self, session_id: str) -> dict[str, Any]:
        now = self._now_text()
        with self._connect() as db:
            row = db.execute(
                "SELECT status, elapsed_seconds, active_since FROM sessions WHERE id=?",
                (session_id,),
            ).fetchone()
            if not row:
                raise ValueError("Session not found.")
            if row["status"] == "active" and row["active_since"]:
                elapsed = int(row["elapsed_seconds"])
                since = datetime.fromisoformat(row["active_since"])
                elapsed += max(0, int((datetime.fromisoformat(now) - since).total_seconds()))
                db.execute(
                    "UPDATE sessions SET elapsed_seconds=?, active_since=?, heartbeat_at=? WHERE id=?",
                    (elapsed, now, now, session_id),
                )
        return self.session(session_id)

    def pause(self, session_id: str) -> dict[str, Any]:
        now = self._now_text()
        with self._connect() as db:
            row = db.execute(
                "SELECT status FROM sessions WHERE id=?", (session_id,)
            ).fetchone()
            if not row:
                raise ValueError("Session not found.")
            if row["status"] == "active":
                self._add_elapsed(db, session_id, now)
                db.execute(
                    "UPDATE sessions SET status='paused', ended_at=NULL WHERE id=?",
                    (session_id,),
                )
        return self.session(session_id)

    def resume(self, session_id: str) -> dict[str, Any]:
        now = self._now_text()
        with self._connect() as db:
            row = db.execute(
                "SELECT status FROM sessions WHERE id=?", (session_id,)
            ).fetchone()
            if not row or row["status"] != "paused":
                raise ValueError("Only a paused session can be resumed.")
            db.execute(
                "UPDATE sessions SET status='active', active_since=?, heartbeat_at=? WHERE id=?",
                (now, now, session_id),
            )
        return self.session(session_id)

    def save_thread_id(self, session_id: str, thread_id: str) -> None:
        with self._connect() as db:
            db.execute(
                "UPDATE sessions SET codex_thread_id=? WHERE id=?", (thread_id, session_id)
            )

    def thread_id(self, session_id: str) -> str | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT codex_thread_id FROM sessions WHERE id=?", (session_id,)
            ).fetchone()
        return row[0] if row else None

    def add_message(self, session_id: str, role: str, content: str) -> None:
        if role not in {"user", "assistant"}:
            raise ValueError("Message role must be user or assistant.")
        with self._connect() as db:
            db.execute(
                "INSERT INTO messages(session_id, role, content, created_at) VALUES(?,?,?,?)",
                (session_id, role, content, self._now_text()),
            )

    def messages(self, session_id: str) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute(
                "SELECT role, content, created_at FROM messages WHERE session_id=? ORDER BY id",
                (session_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def chat_records(self) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute(
                """SELECT s.id, s.topic_id, s.reference_id, s.started_at, s.status FROM sessions s
                   WHERE EXISTS (SELECT 1 FROM messages m WHERE m.session_id=s.id)
                   ORDER BY s.started_at DESC"""
            ).fetchall()
        topics = self.plan["topics"]
        references = {
            reference["id"]: reference
            for topic in topics.values()
            for reference in topic["references"]
        }
        records: list[dict[str, Any]] = []
        for row in rows:
            local_start = self.local_datetime(row["started_at"])
            topic_title = topics.get(row["topic_id"], {}).get("title", row["topic_id"])
            reference_title = references.get(row["reference_id"], {}).get("title", row["reference_id"])
            records.append({
                "session_id": row["id"],
                "title": f"{topic_title} — {reference_title}",
                "date": local_start.date().isoformat(),
                "topic": topic_title,
                "status": row["status"],
            })
        return records

    def chat_record(self, session_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            exists = db.execute("SELECT 1 FROM sessions WHERE id=?", (session_id,)).fetchone()
        if not exists:
            return None
        return {"messages": self.messages(session_id)}

    def active_session(self) -> dict[str, Any] | None:
        """Return the current open session without building the full dashboard."""
        with self._connect() as db:
            row = db.execute(
                "SELECT id FROM sessions WHERE status IN ('active', 'paused') "
                "ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
        return self.session(row["id"]) if row else None

    def session(self, session_id: str) -> dict[str, Any]:
        with self._connect() as db:
            row = db.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
            if not row:
                raise ValueError("Session not found.")
            result = dict(row)
            exercises = db.execute(
                "SELECT exercise_id, description, outcome, notes FROM exercises "
                "WHERE session_id=? ORDER BY id",
                (session_id,),
            ).fetchall()
        if result["active_since"]:
            active_since = datetime.fromisoformat(result["active_since"])
            result["elapsed_seconds"] += max(
                0, int((self._now_utc() - active_since).total_seconds())
            )
        topic = self.plan["topics"].get(result["topic_id"], {})
        reference = next(
            (
                ref
                for ref in topic.get("references", [])
                if ref["id"] == result["reference_id"]
            ),
            {},
        )
        result["topic_title"] = topic.get("title", result["topic_id"])
        result["reference_title"] = reference.get("title", result["reference_id"])
        result["reference_kind"] = reference.get("kind", "book")
        result["exercises"] = [dict(item) for item in exercises]
        result.pop("active_since", None)
        result.pop("heartbeat_at", None)
        return result

    def finish(
        self,
        session_id: str,
        end_position: str,
        concepts: str,
        exercises: list[dict[str, str]],
        score: float | None = None,
        grade_notes: str = "",
        status: str = "completed",
    ) -> dict[str, Any]:
        if status not in {"completed", "interrupted"}:
            raise ValueError("Invalid final status.")
        ended_at = self._now_text()
        with self._connect() as db:
            row = db.execute(
                "SELECT topic_id, reference_id, status FROM sessions WHERE id=?",
                (session_id,),
            ).fetchone()
            if not row:
                raise ValueError("Session not found.")
            if row["status"] not in {"active", "paused"}:
                raise ValueError("That session has already been finished.")
            self._add_elapsed(db, session_id, ended_at)
            db.execute(
                """UPDATE sessions SET status=?, ended_at=?, end_position=?, concepts=?,
                   score=?, grade_notes=? WHERE id=?""",
                (status, ended_at, end_position, concepts.strip(), score, grade_notes.strip(), session_id),
            )
            for exercise in exercises:
                exercise_id = exercise.get("exercise_id", "").strip()
                description = exercise.get("description", "").strip()
                outcome = exercise.get("outcome", "").strip()
                notes = exercise.get("notes", "").strip()
                if not (exercise_id or description or notes):
                    continue
                db.execute(
                    """INSERT INTO exercises
                       (session_id, exercise_id, description, outcome, notes)
                       VALUES (?, ?, ?, ?, ?)""",
                    (session_id, exercise_id, description, outcome or "attempted", notes),
                )
        self._write_end_cursor(row["topic_id"], row["reference_id"], end_position)
        result = self.session(session_id)
        self._write_session_markdown(result)
        self._write_week_markdown(self.local_datetime(result["started_at"]).date())
        return result

    def _write_end_cursor(self, topic_id: str, reference_id: str, position: str) -> None:
        if not position:
            return
        progress = self.progress()
        kind = self._references()[reference_id][2]
        if kind == "book":
            page = int(position)
            progress.setdefault("topics", {}).setdefault(topic_id, {})[
                "next_pdf_page"
            ] = page + 1
        else:
            progress.setdefault("resources", {}).setdefault(reference_id, {})[
                "last_seconds"
            ] = self._position_seconds(position)
        self._save_progress(progress)

    def _write_session_markdown(self, session: dict[str, Any]) -> Path:
        local_start = self.local_datetime(session["started_at"])
        sessions_dir = self.root / "records" / "sessions"
        sessions_dir.mkdir(parents=True, exist_ok=True)
        path = sessions_dir / f"{local_start:%Y-%m-%d}-{session['id'][:8]}.md"
        kind_label = "PDF pages" if session["reference_kind"] == "book" else "Video time"
        exercises = session.get("exercises", [])
        exercise_lines = [
            f"- {item['exercise_id'] or 'Exercise'} — {item['description']} "
            f"({item['outcome']}) {item['notes']}".rstrip()
            for item in exercises
        ] or ["- No exercise result recorded."]
        content = [
            "<!-- Generated by the local Study Dashboard; edit in the dashboard. -->",
            f"# {session['topic_title']} — {session['reference_title']}",
            "",
            f"- Date: {local_start:%Y-%m-%d} ({self.plan['timezone']})",
            f"- Started: {local_start:%Y-%m-%d %H:%M:%S}",
            f"- Finished: {self.local_datetime(session['ended_at']):%Y-%m-%d %H:%M:%S}" if session.get("ended_at") else "- Finished: still in progress",
            f"- Session type: {session['mode']}",
            f"- Status: {session['status']}",
            f"- Study time: {self._format_duration(session['elapsed_seconds'])}",
            f"- {kind_label}: {session['start_position']} → {session['end_position']}",
            f"- Concepts: {session['concepts'] or 'Not recorded'}",
            "- Exercises:",
            *exercise_lines,
        ]
        if session.get("score") is not None:
            content.extend([f"- Score: {session['score']}/10", f"- Grade notes: {session['grade_notes']}"])
        path.write_text("\n".join(content) + "\n", encoding="utf-8")
        return path

    @staticmethod
    def _format_duration(seconds: int) -> str:
        hours, rest = divmod(max(0, seconds), 3600)
        minutes, seconds = divmod(rest, 60)
        return f"{hours}h {minutes:02d}m {seconds:02d}s" if hours else f"{minutes}m {seconds:02d}s"

    def _write_week_markdown(self, local_day: date) -> None:
        monday = local_day - timedelta(days=local_day.weekday())
        sunday = monday + timedelta(days=6)
        sessions = self.history(start_day=monday, end_day=sunday, limit=1000)
        weekly_dir = self.root / "records" / "weekly"
        weekly_dir.mkdir(parents=True, exist_ok=True)
        iso_year, iso_week, _ = local_day.isocalendar()
        base = weekly_dir / f"{iso_year}-W{iso_week:02d}.md"
        path = base
        marker = "<!-- Generated by the local Study Dashboard. -->"
        if path.exists() and marker not in path.read_text(encoding="utf-8"):
            path = weekly_dir / f"{iso_year}-W{iso_week:02d}-dashboard.md"
        rows = [
            marker,
            f"# Study week {iso_year}-W{iso_week:02d}",
            "",
            "| Topic | Reference | Sessions | Study time | Last position | Exercises solved |",
            "|---|---|---:|---:|---|---:|",
        ]
        totals: dict[tuple[str, str], dict[str, Any]] = {}
        for session in sessions:
            key = (session["topic_id"], session["reference_id"])
            row = totals.setdefault(
                key,
                {"topic": session["topic_title"], "reference": session["reference_title"],
                 "sessions": 0, "seconds": 0, "position": "—", "solved": 0},
            )
            row["sessions"] += 1
            row["seconds"] += int(session["elapsed_seconds"])
            if session["end_position"]:
                row["position"] = session["end_position"]
            row["solved"] += sum(1 for item in session.get("exercises", [])
                                  if item["outcome"] in {"solved", "correct", "completed"})
        for row in totals.values():
            rows.append(
                f"| {row['topic']} | {row['reference']} | {row['sessions']} | "
                f"{self._format_duration(row['seconds'])} | {row['position']} | {row['solved']} |"
            )
        rows.extend(["", f"Range: {monday.isoformat()} through {sunday.isoformat()}."])
        path.write_text("\n".join(rows) + "\n", encoding="utf-8")

    def history(
        self,
        start_day: date | None = None,
        end_day: date | None = None,
        limit: int = 30,
    ) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute("SELECT * FROM sessions ORDER BY started_at DESC").fetchall()
            exercise_rows = db.execute(
                "SELECT session_id, exercise_id, description, outcome, notes FROM exercises "
                "ORDER BY id"
            ).fetchall()
        exercises: dict[str, list[dict[str, Any]]] = {}
        for item in exercise_rows:
            exercises.setdefault(item["session_id"], []).append(dict(item))
        result: list[dict[str, Any]] = []
        for row in rows:
            local_start = self.local_datetime(row["started_at"])
            if start_day and local_start.date() < start_day:
                continue
            if end_day and local_start.date() > end_day:
                continue
            result.append(self.session(row["id"]))
            if len(result) >= limit:
                break
        return result

    def dashboard(self) -> dict[str, Any]:
        history = self.history(limit=1000)
        totals: dict[str, dict[str, Any]] = {
            topic_id: {"topic_id": topic_id, "title": topic["title"], "seconds": 0,
                       "sessions": 0, "solved": 0, "exercises": 0, "references": []}
            for topic_id, topic in self.plan["topics"].items()
        }
        reference_totals: dict[str, dict[str, Any]] = {}
        exercises_solved = 0
        for session in history:
            if session["status"] not in {"completed", "interrupted", "active", "paused"}:
                continue
            topic = totals.get(session["topic_id"])
            if not topic:
                continue
            seconds = int(session["elapsed_seconds"])
            topic["seconds"] += seconds
            topic["sessions"] += 1
            solved = sum(1 for item in session["exercises"]
                         if item["outcome"] in {"solved", "correct", "completed"})
            topic["solved"] += solved
            topic["exercises"] += len(session["exercises"])
            exercises_solved += solved
            ref = reference_totals.setdefault(
                session["reference_id"],
                {"reference_id": session["reference_id"], "topic_title": session["topic_title"],
                 "title": session["reference_title"], "kind": session["reference_kind"],
                 "seconds": 0, "sessions": 0, "start_position": session["start_position"],
                 "end_position": session["end_position"]},
            )
            ref["seconds"] += seconds
            ref["sessions"] += 1
            if session["end_position"]:
                ref["end_position"] = session["end_position"]
        for reference in self.list_references():
            reference["seconds"] = reference_totals.get(reference["id"], {}).get("seconds", 0)
            reference["sessions"] = reference_totals.get(reference["id"], {}).get("sessions", 0)
            reference["last_position"] = reference_totals.get(reference["id"], {}).get("end_position")
            totals[reference["topic_id"]]["references"].append(reference)
        active = next((s for s in history if s["status"] in {"active", "paused"}), None)
        now_local = datetime.now(self.timezone)
        week_start = now_local.date() - timedelta(days=now_local.weekday())
        week_history = self.history(start_day=week_start, end_day=week_start + timedelta(days=6), limit=1000)
        return {
            "timezone": self.plan["timezone"],
            "total_seconds": sum(item["seconds"] for item in totals.values()),
            "total_sessions": sum(item["sessions"] for item in totals.values()),
            "exercises_solved": exercises_solved,
            "week_seconds": sum(item["elapsed_seconds"] for item in week_history),
            "topics": list(totals.values()),
            "references": list(reference_totals.values()),
            "history": history[:30],
            "active_session": active,
        }

