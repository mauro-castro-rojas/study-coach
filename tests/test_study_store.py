import json
import tempfile
import unittest
from pathlib import Path

from scripts.study_web.storage import StudyStore


def sample_plan() -> dict:
    return {
        "timezone": "America/Bogota",
        "weekly_assessment": {"minutes_per_topic": 12, "topics": ["linux", "3d-modeling"]},
        "topics": {
            "linux": {
                "title": "Linux",
                "references": [{
                    "id": "blum-linux-bible", "title": "Linux Bible", "kind": "book",
                    "path": "topics/linux/book.pdf", "default_minutes": 15,
                }],
            },
            "3d-modeling": {
                "title": "3D modeling",
                "references": [{
                    "id": "freecad-robot-arm", "title": "FreeCAD", "kind": "video",
                    "url": "https://example.invalid/video", "default_minutes": 40,
                }],
            },
        },
    }


class StudyStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "records").mkdir(parents=True)
        progress = {
            "topics": {"linux": {"next_pdf_page": 4}},
            "resources": {"freecad-robot-arm": {"last_seconds": 0}},
        }
        (self.root / "records" / "progress.json").write_text(
            json.dumps(progress), encoding="utf-8"
        )
        self.store = StudyStore(self.root, sample_plan())
        self.assertFalse((self.root / "records" / "progress.json").exists())
        self.assertEqual(self.store.progress()["topics"]["linux"]["next_pdf_page"], 4)
        self.assertEqual(self.store.progress()["resources"]["freecad-robot-arm"]["last_seconds"], 0)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_book_session_saves_exercise_pages_and_markdown_export(self) -> None:
        session = self.store.start_session(
            "linux", "blum-linux-bible", 15 * 60, "4", setup_seconds=30
        )
        self.assertEqual(session["status"], "active")
        self.assertEqual(session["start_position"], "4")
        paused = self.store.pause(session["id"])
        self.assertEqual(paused["status"], "paused")
        resumed = self.store.resume(session["id"])
        self.assertEqual(resumed["status"], "active")
        final = self.store.finish(
            session["id"],
            "7",
            "File permissions and ownership",
            [{"exercise_id": "4.2", "description": "Inspect permissions", "outcome": "solved", "notes": "Correct."}],
        )
        self.assertEqual(final["status"], "completed")
        self.assertEqual(final["end_position"], "7")
        self.assertEqual(self.store.progress()["topics"]["linux"]["next_pdf_page"], 8)
        self.assertEqual(self.store.dashboard()["exercises_solved"], 1)
        exports = list((self.root / "records" / "sessions").glob("*.md"))
        self.assertEqual(len(exports), 1)
        self.assertIn("File permissions and ownership", exports[0].read_text(encoding="utf-8"))
        week = self.store.local_datetime(final["started_at"]).date().isocalendar()
        self.assertIn(f"{week.year}-W{week.week:02d}", [
            record["id"] for record in self.store.weekly_records()
        ])
        self.assertIn("| Linux | Linux Bible | 1 |", self.store.weekly_summary(week.year, week.week))

    def test_only_one_open_session_at_a_time(self) -> None:
        self.store.start_session("linux", "blum-linux-bible", None, "4")
        with self.assertRaisesRegex(ValueError, "current session"):
            self.store.start_session("3d-modeling", "freecad-robot-arm", None, "00:00")

    def test_optional_time_goal_sound_setting_is_saved(self) -> None:
        session = self.store.start_session(
            "linux", "blum-linux-bible", 10 * 60, "4", sound_on_target=True
        )
        self.assertTrue(session["sound_on_target"])


if __name__ == "__main__":
    unittest.main()
