"""SQLite persistence and readable exports for browser study sessions."""

from __future__ import annotations

import json
import re
import sqlite3
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


class StudyStore:
    def __init__(
        self,
        root: Path,
        plan: dict[str, Any] | None = None,
        *,
        legacy_plan_path: Path | None = None,
    ):
        self.root = root
        self.db_path = root / "records" / "study.sqlite3"
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.progress_path = root / "records" / "progress.json"
        self.legacy_plan_path = legacy_plan_path
        self._initialize()
        if not self._has_plan():
            self._initialize_plan(plan)
        self.plan = self._load_plan()
        self.timezone = ZoneInfo(self.plan["timezone"])
        self._migrate_legacy_progress()
        self._recover_open_sessions()

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
                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    topic_id TEXT NOT NULL,
                    reference_id TEXT NOT NULL,
                    mode TEXT NOT NULL DEFAULT 'lesson',
                    coach_mode TEXT NOT NULL DEFAULT 'coach',
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
                    page_ranges TEXT NOT NULL DEFAULT '[]',
                    codex_thread_id TEXT,
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
                CREATE TABLE IF NOT EXISTS page_reads (
                    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    pdf_page INTEGER NOT NULL,
                    printed_page TEXT NOT NULL DEFAULT '',
                    summary TEXT NOT NULL,
                    concepts TEXT NOT NULL DEFAULT '[]',
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(session_id, pdf_page)
                );
                CREATE TABLE IF NOT EXISTS study_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS study_topics (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    sort_order INTEGER NOT NULL UNIQUE
                );
                CREATE TABLE IF NOT EXISTS study_references (
                    id TEXT PRIMARY KEY,
                    topic_id TEXT NOT NULL REFERENCES study_topics(id) ON DELETE CASCADE,
                    title TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK(kind IN ('book', 'video')),
                    file_path TEXT,
                    url TEXT,
                    default_minutes INTEGER NOT NULL,
                    sort_order INTEGER NOT NULL,
                    UNIQUE(topic_id, sort_order),
                    CHECK((kind = 'book' AND file_path IS NOT NULL) OR
                          (kind = 'video' AND url IS NOT NULL))
                );
                CREATE TABLE IF NOT EXISTS weekly_assessment_topics (
                    topic_id TEXT PRIMARY KEY REFERENCES study_topics(id) ON DELETE CASCADE,
                    sort_order INTEGER NOT NULL UNIQUE
                );
                CREATE TABLE IF NOT EXISTS topic_progress (
                    topic_id TEXT PRIMARY KEY REFERENCES study_topics(id) ON DELETE CASCADE,
                    next_pdf_page INTEGER NOT NULL CHECK(next_pdf_page > 0)
                );
                CREATE TABLE IF NOT EXISTS reference_progress (
                    reference_id TEXT PRIMARY KEY REFERENCES study_references(id) ON DELETE CASCADE,
                    last_seconds INTEGER NOT NULL CHECK(last_seconds >= 0)
                );
                CREATE INDEX IF NOT EXISTS sessions_topic_idx
                    ON sessions(topic_id, reference_id, started_at);
                CREATE INDEX IF NOT EXISTS exercises_session_idx
                    ON exercises(session_id);
                CREATE INDEX IF NOT EXISTS messages_session_idx
                    ON messages(session_id, id);
                """
            )
            page_columns = {
                row["name"] for row in db.execute("PRAGMA table_info(page_reads)").fetchall()
            }
            if "viewer_page" in page_columns and "pdf_page" not in page_columns:
                db.execute("ALTER TABLE page_reads RENAME COLUMN viewer_page TO pdf_page")
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS page_images (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    pdf_page INTEGER NOT NULL,
                    relative_path TEXT NOT NULL UNIQUE,
                    mime_type TEXT NOT NULL CHECK(mime_type = 'image/png'),
                    byte_size INTEGER NOT NULL,
                    width INTEGER NOT NULL,
                    height INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(session_id, pdf_page)
                        REFERENCES page_reads(session_id, pdf_page) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS page_images_summary_idx
                    ON page_images(session_id, pdf_page, created_at);
                """
            )
            session_columns = {
                row["name"] for row in db.execute("PRAGMA table_info(sessions)").fetchall()
            }
            if "page_ranges" not in session_columns:
                db.execute("ALTER TABLE sessions ADD COLUMN page_ranges TEXT NOT NULL DEFAULT '[]'")
            if "coach_mode" not in session_columns:
                db.execute("ALTER TABLE sessions ADD COLUMN coach_mode TEXT NOT NULL DEFAULT 'coach'")

    def _has_plan(self) -> bool:
        with self._connect() as db:
            return db.execute("SELECT 1 FROM study_topics LIMIT 1").fetchone() is not None

    def _initialize_plan(self, plan: dict[str, Any] | None) -> None:
        if plan is not None:
            self._insert_plan(plan)
            return
        if self.legacy_plan_path and self.legacy_plan_path.is_file():
            try:
                legacy_plan = json.loads(self.legacy_plan_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise RuntimeError(f"Could not import the old study plan: {error}") from error
            self._insert_plan(legacy_plan)
            try:
                self.legacy_plan_path.unlink()
            except OSError:
                pass
            return
        # A fresh install can start with an empty plan. Topics will be added by
        # the planned topic-management UI instead of being copied from defaults.

    def _insert_plan(self, plan: dict[str, Any]) -> None:
        with self._connect() as db:
            db.execute(
                "INSERT OR IGNORE INTO study_settings(key, value) VALUES('timezone', ?)",
                (str(plan["timezone"]),),
            )
            weekly = plan.get("weekly_assessment", {})
            db.execute(
                "INSERT OR IGNORE INTO study_settings(key, value) "
                "VALUES('weekly_assessment_minutes', ?)",
                (str(int(weekly.get("minutes_per_topic", 0))),),
            )
            for topic_order, (topic_id, topic) in enumerate(plan["topics"].items()):
                db.execute(
                    "INSERT OR IGNORE INTO study_topics(id, title, sort_order) VALUES(?, ?, ?)",
                    (topic_id, str(topic["title"]), topic_order),
                )
                for reference_order, reference in enumerate(topic.get("references", [])):
                    db.execute(
                        """INSERT OR IGNORE INTO study_references
                           (id, topic_id, title, kind, file_path, url, default_minutes, sort_order)
                           VALUES(?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            str(reference["id"]),
                            topic_id,
                            str(reference["title"]),
                            str(reference["kind"]),
                            reference.get("path"),
                            reference.get("url"),
                            int(reference["default_minutes"]),
                            reference_order,
                        ),
                    )
            for order, topic_id in enumerate(weekly.get("topics", [])):
                db.execute(
                    "INSERT OR IGNORE INTO weekly_assessment_topics(topic_id, sort_order) "
                    "VALUES(?, ?)",
                    (str(topic_id), order),
                )

    def _load_plan(self) -> dict[str, Any]:
        with self._connect() as db:
            settings = {
                row["key"]: row["value"]
                for row in db.execute("SELECT key, value FROM study_settings")
            }
            topics: dict[str, dict[str, Any]] = {}
            for row in db.execute("SELECT id, title FROM study_topics ORDER BY sort_order"):
                topics[row["id"]] = {"title": row["title"], "references": []}
            references = db.execute(
                """SELECT id, topic_id, title, kind, file_path, url, default_minutes
                   FROM study_references ORDER BY topic_id, sort_order"""
            ).fetchall()
            for row in references:
                reference = {
                    "id": row["id"],
                    "title": row["title"],
                    "kind": row["kind"],
                    "default_minutes": int(row["default_minutes"]),
                }
                if row["file_path"] is not None:
                    reference["path"] = row["file_path"]
                if row["url"] is not None:
                    reference["url"] = row["url"]
                topics[row["topic_id"]]["references"].append(reference)
            weekly_topics = [
                row["topic_id"]
                for row in db.execute(
                    "SELECT topic_id FROM weekly_assessment_topics ORDER BY sort_order"
                )
            ]
        return {
            "timezone": settings.get("timezone", "UTC"),
            "weekly_assessment": {
                "minutes_per_topic": int(settings.get("weekly_assessment_minutes", 0)),
                "topics": weekly_topics,
            },
            "topics": topics,
        }

    def _migrate_legacy_progress(self) -> None:
        with self._connect() as db:
            migrated = db.execute(
                "SELECT 1 FROM study_settings WHERE key='progress_json_migrated_v1'"
            ).fetchone()
        if migrated:
            return

        legacy = {"topics": {}, "resources": {}}
        if self.progress_path.is_file():
            try:
                legacy = json.loads(self.progress_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise RuntimeError(f"Could not import saved resume positions: {error}") from error
        valid_topics = set(self.plan["topics"])
        valid_references = {
            reference["id"]
            for topic in self.plan["topics"].values()
            for reference in topic["references"]
        }
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            for topic_id, value in legacy.get("topics", {}).items():
                if topic_id not in valid_topics or not isinstance(value, dict):
                    continue
                try:
                    next_page = int(value["next_pdf_page"])
                except (KeyError, TypeError, ValueError):
                    continue
                if next_page > 0:
                    db.execute(
                        "INSERT OR IGNORE INTO topic_progress(topic_id, next_pdf_page) VALUES(?, ?)",
                        (topic_id, next_page),
                    )
            for reference_id, value in legacy.get("resources", {}).items():
                if reference_id not in valid_references or not isinstance(value, dict):
                    continue
                try:
                    last_seconds = max(0, int(value.get("last_seconds", 0)))
                except (TypeError, ValueError):
                    continue
                db.execute(
                    "INSERT OR IGNORE INTO reference_progress(reference_id, last_seconds) "
                    "VALUES(?, ?)",
                    (reference_id, last_seconds),
                )
            db.execute(
                "INSERT INTO study_settings(key, value) VALUES('progress_json_migrated_v1', '1')"
            )

        if self.progress_path.is_file():
            try:
                self.progress_path.unlink()
            except OSError:
                pass

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

    def _now_utc(self) -> datetime:
        return datetime.now(timezone.utc)

    def _now_text(self) -> str:
        return self._now_utc().isoformat(timespec="seconds")

    def local_datetime(self, value: str) -> datetime:
        return datetime.fromisoformat(value).astimezone(self.timezone)

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

    def progress(self) -> dict[str, Any]:
        with self._connect() as db:
            topics = db.execute(
                "SELECT topic_id, next_pdf_page FROM topic_progress ORDER BY topic_id"
            ).fetchall()
            resources = db.execute(
                "SELECT reference_id, last_seconds FROM reference_progress ORDER BY reference_id"
            ).fetchall()
        return {
            "topics": {
                row["topic_id"]: {"next_pdf_page": int(row["next_pdf_page"])}
                for row in topics
            },
            "resources": {
                row["reference_id"]: {"last_seconds": int(row["last_seconds"])}
                for row in resources
            },
        }

    def _save_progress(self, progress: dict[str, Any]) -> None:
        known_topics = set(self.plan["topics"])
        known_references = {
            reference["id"]
            for topic in self.plan["topics"].values()
            for reference in topic["references"]
        }
        with self._connect() as db:
            for topic_id, value in progress.get("topics", {}).items():
                if topic_id not in known_topics or not isinstance(value, dict):
                    continue
                try:
                    next_page = int(value["next_pdf_page"])
                except (KeyError, TypeError, ValueError):
                    continue
                if next_page < 1:
                    continue
                db.execute(
                    """INSERT INTO topic_progress(topic_id, next_pdf_page) VALUES(?, ?)
                       ON CONFLICT(topic_id) DO UPDATE SET next_pdf_page=excluded.next_pdf_page""",
                    (topic_id, next_page),
                )
            for reference_id, value in progress.get("resources", {}).items():
                if reference_id not in known_references or not isinstance(value, dict):
                    continue
                try:
                    last_seconds = max(0, int(value.get("last_seconds", 0)))
                except (TypeError, ValueError):
                    continue
                db.execute(
                    """INSERT INTO reference_progress(reference_id, last_seconds) VALUES(?, ?)
                       ON CONFLICT(reference_id) DO UPDATE SET last_seconds=excluded.last_seconds""",
                    (reference_id, last_seconds),
                )

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
        coach_mode: str = "coach",
        setup_seconds: int = 0,
        sound_on_target: bool = False,
    ) -> dict[str, Any]:
        references = self._references()
        if reference_id not in references or references[reference_id][0] != topic_id:
            raise ValueError("That reference does not belong to the selected topic.")
        if mode not in {"lesson", "assessment"}:
            raise ValueError("Unknown session mode.")
        if coach_mode not in {"coach", "manual"}:
            raise ValueError("Unknown study mode.")
        with self._connect() as db:
            if db.execute(
                "SELECT 1 FROM sessions WHERE status IN ('active','paused') LIMIT 1"
            ).fetchone():
                raise ValueError("Finish or resume the current session before starting another.")
            session_id = uuid.uuid4().hex
            now = self._now_text()
            db.execute(
                """INSERT INTO sessions
                   (id, topic_id, reference_id, mode, coach_mode, status, started_at, active_since,
                    heartbeat_at, elapsed_seconds, setup_seconds, planned_seconds, sound_on_target,
                    start_position, created_at)
                   VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, 0, ?, ?, ?, ?, ?)""",
                (
                    session_id,
                    topic_id,
                    reference_id,
                    mode,
                    coach_mode,
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

    def record_exercise(
        self, session_id: str, exercise_id: str, description: str, notes: str
    ) -> None:
        with self._connect() as db:
            db.execute(
                """INSERT INTO exercises
                   (session_id, exercise_id, description, outcome, notes)
                   VALUES (?, ?, ?, 'attempted', ?)""",
                (session_id, exercise_id[:160], description[:2000], notes[:2000]),
            )

    def save_page_read(
        self,
        session_id: str,
        pdf_page: int,
        printed_page: str,
        summary: str,
        concepts: list[str],
        book_exercises: list[dict[str, str]],
    ) -> tuple[dict[str, Any], bool]:
        with self._connect() as db:
            session = db.execute(
                "SELECT status FROM sessions WHERE id=?", (session_id,)
            ).fetchone()
            if not session or session["status"] not in {"active", "paused"}:
                raise ValueError("This session is already finished.")
            existing = db.execute(
                "SELECT * FROM page_reads WHERE session_id=? AND pdf_page=?",
                (session_id, pdf_page),
            ).fetchone()
            if existing:
                row = dict(existing)
                row["concepts"] = json.loads(row["concepts"])
                return row, False
            db.execute(
                """INSERT INTO page_reads
                   (session_id, pdf_page, printed_page, summary, concepts, created_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (session_id, pdf_page, printed_page, summary, json.dumps(concepts), self._now_text()),
            )
            for exercise in book_exercises:
                db.execute(
                    """INSERT INTO exercises
                       (session_id, exercise_id, description, outcome, notes)
                       VALUES (?, ?, ?, 'attempted', ?)""",
                    (
                        session_id,
                        exercise["exercise_id"],
                        exercise["prompt"],
                        f"Book exercise from PDF viewer page {pdf_page}.",
                    ),
                )
            saved = db.execute(
                "SELECT * FROM page_reads WHERE session_id=? AND pdf_page=?",
                (session_id, pdf_page),
            ).fetchone()
        row = dict(saved)
        row["concepts"] = json.loads(row["concepts"])
        self._write_session_markdown(self.session(session_id))
        return row, True

    def update_page_summary(self, session_id: str, pdf_page: int, summary: str) -> dict[str, Any]:
        attachment_paths: list[str] = []
        attachment_ids = set(re.findall(
            r"!\[[^\]]*\]\(\.\./attachments/([a-f0-9]{32})/([a-f0-9]{32})\.png\)",
            summary,
        ))
        referenced_ids = {
            image_id for attachment_session, image_id in attachment_ids
            if attachment_session == session_id
        }
        with self._connect() as db:
            session = db.execute(
                "SELECT status FROM sessions WHERE id=?", (session_id,)
            ).fetchone()
            if not session or session["status"] not in {"active", "paused"}:
                raise ValueError("This session is already finished.")
            updated = db.execute(
                "UPDATE page_reads SET summary=? WHERE session_id=? AND pdf_page=?",
                (summary, session_id, pdf_page),
            )
            if updated.rowcount != 1:
                raise ValueError("That page has not been marked as read.")
            images = db.execute(
                "SELECT id, relative_path FROM page_images WHERE session_id=? AND pdf_page=?",
                (session_id, pdf_page),
            ).fetchall()
            for image in images:
                if image["id"] not in referenced_ids:
                    attachment_paths.append(image["relative_path"])
                    db.execute("DELETE FROM page_images WHERE id=?", (image["id"],))
            row = db.execute(
                "SELECT * FROM page_reads WHERE session_id=? AND pdf_page=?",
                (session_id, pdf_page),
            ).fetchone()
            current_images = db.execute(
                """SELECT id, pdf_page, mime_type, byte_size, width, height, created_at
                   FROM page_images WHERE session_id=? AND pdf_page=? ORDER BY created_at, id""",
                (session_id, pdf_page),
            ).fetchall()
        self._remove_attachment_files(attachment_paths)
        result = dict(row)
        result["concepts"] = json.loads(result["concepts"])
        result["images"] = [dict(image) for image in current_images]
        self._write_session_markdown(self.session(session_id))
        return result

    def _remove_attachment_files(self, relative_paths: list[str]) -> tuple[int, int]:
        attachments_base = self.root / "records" / "attachments"
        if attachments_base.is_symlink():
            return 0, len(relative_paths)
        attachments_root = attachments_base.resolve()
        removed = 0
        errors = 0
        for relative_path in relative_paths:
            candidate = self.root / "records" / relative_path
            if candidate.is_symlink() or candidate.parent.is_symlink():
                errors += 1
                continue
            image_path = candidate.resolve()
            if not image_path.is_relative_to(attachments_root):
                errors += 1
                continue
            try:
                if image_path.is_file():
                    image_path.unlink()
                    removed += 1
                parent = image_path.parent
                if parent != attachments_root and parent.is_dir() and not any(parent.iterdir()):
                    parent.rmdir()
            except OSError:
                errors += 1
        return removed, errors

    def add_page_image(
        self,
        session_id: str,
        pdf_page: int,
        image_bytes: bytes,
        width: int,
        height: int,
    ) -> dict[str, Any]:
        session = self.session(session_id)
        if session["status"] not in {"active", "paused"}:
            raise ValueError("This session is already finished.")
        if session["reference_kind"] != "book" or session["mode"] == "assessment":
            raise ValueError("Page images are available during PDF lessons.")
        image_id = uuid.uuid4().hex
        relative_path = Path("attachments") / session_id / f"{image_id}.png"
        image_path = self.root / "records" / relative_path
        attachments_base = self.root / "records" / "attachments"
        if attachments_base.is_symlink() or image_path.parent.is_symlink():
            raise ValueError("The screenshot attachment folder cannot be used safely.")
        image_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not image_path.parent.resolve().is_relative_to(attachments_base.resolve()):
            raise ValueError("The screenshot attachment folder cannot be used safely.")
        image_path.parent.chmod(0o700)
        try:
            with image_path.open("xb") as target:
                target.write(image_bytes)
            image_path.chmod(0o600)
            created_at = self._now_text()
            with self._connect() as db:
                page = db.execute(
                    "SELECT 1 FROM page_reads WHERE session_id=? AND pdf_page=?",
                    (session_id, pdf_page),
                ).fetchone()
                if not page:
                    raise ValueError("Mark this PDF page as read before pasting an image.")
                db.execute(
                    """INSERT INTO page_images
                       (id, session_id, pdf_page, relative_path, mime_type, byte_size,
                        width, height, created_at)
                       VALUES (?, ?, ?, ?, 'image/png', ?, ?, ?, ?)""",
                    (
                        image_id,
                        session_id,
                        pdf_page,
                        relative_path.as_posix(),
                        len(image_bytes),
                        width,
                        height,
                        created_at,
                    ),
                )
        except Exception:
            image_path.unlink(missing_ok=True)
            raise
        return {
            "id": image_id,
            "pdf_page": pdf_page,
            "mime_type": "image/png",
            "byte_size": len(image_bytes),
            "width": width,
            "height": height,
            "created_at": created_at,
        }

    def page_image(self, session_id: str, image_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                """SELECT id, session_id, pdf_page, relative_path, mime_type, byte_size,
                          width, height, created_at
                   FROM page_images WHERE session_id=? AND id=?""",
                (session_id, image_id),
            ).fetchone()
        return dict(row) if row else None

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

    def session_for_export(self, filename: str) -> dict[str, Any] | None:
        """Resolve an app-generated session export to its structured record."""
        match = re.fullmatch(r"\d{4}-\d{2}-\d{2}-([a-f0-9]{8})\.md", filename)
        if not match:
            return None
        with self._connect() as db:
            rows = db.execute(
                "SELECT id FROM sessions WHERE id LIKE ? LIMIT 2",
                (match.group(1) + "%",),
            ).fetchall()
        if len(rows) != 1:
            return None
        return self.session(rows[0]["id"])

    def clear_records(self) -> dict[str, int]:
        """Delete saved session data and only exports generated by this app."""
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute(
                "SELECT 1 FROM sessions WHERE status IN ('active', 'paused') LIMIT 1"
            ).fetchone():
                raise ValueError("Finish the open session before clearing study records.")
            counts = {
                "sessions": db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0],
                "messages": db.execute("SELECT COUNT(*) FROM messages").fetchone()[0],
                "exercises": db.execute("SELECT COUNT(*) FROM exercises").fetchone()[0],
                "images": db.execute("SELECT COUNT(*) FROM page_images").fetchone()[0],
            }
            image_paths = [
                row["relative_path"] for row in db.execute(
                    "SELECT relative_path FROM page_images"
                ).fetchall()
            ]
            db.execute("DELETE FROM sessions")

        removed_images, attachment_errors = self._remove_attachment_files(image_paths)

        generated_markers = {
            "sessions": "<!-- Generated by the local Study Dashboard; edit in the dashboard. -->",
            "weekly": "<!-- Generated by the local Study Dashboard. -->",
        }
        removed_exports = 0
        export_errors = 0
        for kind, marker in generated_markers.items():
            folder = self.root / "records" / kind
            if not folder.is_dir():
                continue
            for export in folder.glob("*.md"):
                if export.is_symlink() or not export.is_file():
                    continue
                try:
                    with export.open(encoding="utf-8") as source:
                        generated = source.readline().strip() == marker
                    if generated:
                        export.unlink()
                        removed_exports += 1
                except (OSError, UnicodeError):
                    export_errors += 1

        return {
            **counts,
            "images": removed_images,
            "attachment_errors": attachment_errors,
            "exports": removed_exports,
            "export_errors": export_errors,
        }

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
            row = db.execute(
                """SELECT id, topic_id, reference_id, mode, coach_mode, status, started_at, ended_at,
                          active_since, heartbeat_at, elapsed_seconds, setup_seconds,
                          planned_seconds, sound_on_target, start_position, end_position,
                          concepts, score, grade_notes, page_ranges, codex_thread_id, created_at
                   FROM sessions WHERE id=?""",
                (session_id,),
            ).fetchone()
            if not row:
                raise ValueError("Session not found.")
            result = dict(row)
            exercises = db.execute(
                "SELECT exercise_id, description, outcome, notes FROM exercises "
                "WHERE session_id=? ORDER BY id",
                (session_id,),
            ).fetchall()
            page_reads = db.execute(
                "SELECT pdf_page, printed_page, summary, concepts, created_at "
                "FROM page_reads WHERE session_id=? ORDER BY created_at, pdf_page",
                (session_id,),
            ).fetchall()
            page_images = db.execute(
                """SELECT id, pdf_page, mime_type, byte_size, width, height, created_at
                   FROM page_images WHERE session_id=? ORDER BY created_at, id""",
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
        images_by_page: dict[int, list[dict[str, Any]]] = {}
        for image in page_images:
            images_by_page.setdefault(int(image["pdf_page"]), []).append(dict(image))
        result["page_reads"] = [
            {
                **dict(item),
                "concepts": json.loads(item["concepts"]),
                "images": images_by_page.get(int(item["pdf_page"]), []),
            }
            for item in page_reads
        ]
        result["page_ranges"] = json.loads(result["page_ranges"] or "[]")
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
        page_ranges: list[dict[str, Any]] | None = None,
        page_summaries: dict[int, str] | None = None,
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
                   score=?, grade_notes=?, page_ranges=? WHERE id=?""",
                (
                    status,
                    ended_at,
                    end_position,
                    concepts.strip(),
                    score,
                    grade_notes.strip(),
                    json.dumps(page_ranges or [], ensure_ascii=False),
                    session_id,
                ),
            )
            for pdf_page, summary in (page_summaries or {}).items():
                db.execute(
                    "UPDATE page_reads SET summary=? WHERE session_id=? AND pdf_page=?",
                    (summary, session_id, pdf_page),
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
            f"- {item['exercise_id'] or 'Exercise'} — {item['description'].replace(chr(10), ' ')} "
            f"({item['outcome']}) {item['notes']}".rstrip()
            for item in exercises
        ] or ["- No exercise result recorded."]
        concept_lines = [
            f"  - {line.removeprefix('- ').strip()}"
            for line in session["concepts"].splitlines()
            if line.strip()
        ] or ["  - Not recorded"]
        has_page_summaries = session["reference_kind"] == "book" and bool(session.get("page_reads"))
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
            f"- {kind_label}: {session['start_position']} → {session['end_position'] or 'in progress'}",
        ]
        if not has_page_summaries:
            content.extend(["- Concepts:", *concept_lines])
        content.extend(["- Exercises:", *exercise_lines])
        if session.get("score") is not None:
            content.extend([f"- Score: {session['score']}/10", f"- Grade notes: {session['grade_notes']}"])
        if session.get("page_reads"):
            content.extend(["", "## Pages read", ""])
            for page_read in session["page_reads"]:
                pdf_page = int(page_read["pdf_page"])
                page_range = next(
                    (
                        item
                        for item in session.get("page_ranges", [])
                        if int(item["start_page"]) <= pdf_page <= int(item["end_page"])
                    ),
                    None,
                )
                page_title = f"PDF page {pdf_page}"
                if page_range:
                    page_title = (
                        f"Chapter {page_range['chapter']} · Section {page_range['section']} "
                        f"— PDF page {pdf_page}"
                    )
                content.extend([f"### {page_title}", "", page_read["summary"].strip(), ""])
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
            rows = db.execute(
                "SELECT id, started_at FROM sessions ORDER BY started_at DESC"
            ).fetchall()
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

