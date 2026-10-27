#!/usr/bin/env python3
"""Launch the local Study Room browser dashboard."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from study_web.server import StudyApplication, StudyHTTPServer


ROOT = Path(__file__).resolve().parents[1]


def open_browser(url: str) -> bool:
    try:
        subprocess.Popen(
            ["cmd.exe", "/c", "start", "", url],
            cwd="/mnt/c",
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return True
    except OSError:
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true", help="start the local server without opening a browser")
    args = parser.parse_args()

    pdfjs_dist = ROOT / "node_modules" / "@missing-elements" / "pdfjs-viewer" / "dist"
    required_assets = (
        pdfjs_dist / "pdfjs-viewer-element.js",
        pdfjs_dist / "viewer.mjs",
        pdfjs_dist / "pdf.mjs",
        pdfjs_dist / "pdf.worker.min.mjs",
        pdfjs_dist / "viewer.css",
        pdfjs_dist / "paper-and-ink.css",
        ROOT / "node_modules" / "katex" / "dist" / "katex.min.js",
        ROOT / "node_modules" / "katex" / "dist" / "katex.min.css",
    )
    missing_assets = [path for path in required_assets if not path.is_file()]
    if missing_assets:
        print("Study Room browser dependencies are missing. Run `npm ci` from the project root.", file=sys.stderr)
        print("See README.md for Node.js setup instructions.", file=sys.stderr)
        return 1

    plan_path = ROOT / "config" / "study-plan.json"
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    app = StudyApplication(ROOT, plan)
    try:
        server = StudyHTTPServer(("127.0.0.1", args.port), app)
    except OSError as error:
        print(f"Could not start Study Room on port {args.port}: {error}", file=sys.stderr)
        print("If another dashboard is already open, use that browser tab.", file=sys.stderr)
        return 1

    url = f"http://127.0.0.1:{server.server_address[1]}"
    print(f"Study Room is available at {url}")
    print("This server listens only on this computer. Press Ctrl+C here to stop it.")
    if not args.no_browser and not open_browser(url):
        print(f"Open {url} in your Windows browser.")
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print("\nStopping Study Room…")
    finally:
        server.shutdown()
        server.server_close()
        if app._bridge:
            app._bridge.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
