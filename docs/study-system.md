# Study Room

Study Room is a private, local browser app for self-paced lessons, a Codex-powered
Study Coach, a live timer, and durable learning records. It replaces the old
fixed weekday rotation; it does not set a mandatory hour or session length.

## Start and stop

From WSL, run:

```bash
cd ~/learn
./study
```

This starts a server bound to `127.0.0.1`, opens the dashboard in the Windows
browser, and keeps the server running in that terminal. Press `Ctrl+C` in the
launching terminal to stop it. Study Room is not available to other computers
on the network. If the browser does not open, visit the local address printed
by the command (normally `http://127.0.0.1:8765`).

The dashboard is the daily entry point. Choose a topic and reference, then
optionally set a time goal; sessions are open-ended by default. For a lesson, the reference opens in another
browser tab for videos. PDFs open inside the lesson view. Find your starting
page with the PDF viewer's built-in controls, enter it below, and click **Begin
lesson**. The active-study timer starts only when you click Begin. Reaching a
chosen time goal gives a visual reminder; a soft sound can also be enabled. It
never pauses or ends the session. Practice tests are closed book.

The Study Coach panel can be hidden to widen the reader and shown again at any
time. The time card displays elapsed active-study time and a live local clock
in `America/Bogota`. The locally bundled Mozilla PDF.js v6.4.299 reader renders
the OneDrive-backed file in the page and keeps its built-in page controls (the
upstream license is included at `web/pdfjs/LICENSE`). During a PDF lesson, mark
a page as read after you finish it. Only that explicit action sends the current
page image and extracted text to Codex. The app saves the PDF viewer page, the
printed page label when readable, a concise summary, and the detected concepts
to the open session as soon as the page is checked. Page changes alone are not
sent. Page summaries are kept in the session record, not shown as chat messages.
The raw page image and extracted text are sent to Codex for that request; Study
Room keeps the resulting summary and page metadata rather than a local copy of
the page image.
If the page contains an actual book exercise, the Coach presents it in the
conversation and records its printed identifier.

The timer counts active study time and can be paused. A PDF lesson requires at
least one page marked as read before **Finish & log** is available. Finishing
automatically saves the checked pages, their summaries and concepts, book
exercises, and exercises requested in the Coach conversation. The session
Markdown log is updated as pages are recorded and finalized when the session
ends. The visible Coach conversation is saved separately with the session;
internal page-capture instructions and summaries are not added to the chat.

## Dashboard and records

The dashboard summarizes active time by topic and reference book, number of
sessions, exercises solved, this week's study time, and recent sessions. Video
references have their own progress cursors. More than one session on a day is
fine; all sessions contribute to the totals.

For the planned two-hour Saturday review, run one 12-minute closed-book test
for each of the ten configured topics, including 3D modeling. Start each from
the topic card's **Practice test** option, then log its score and grade notes.
The dashboard retains ten separate grades and rolls up the sessions by topic.
The current version does not launch or enforce that ten-part sequence as one
automatic two-hour exam.

The local SQLite database at `records/study.sqlite3` is the structured source
for sessions, page summaries, chat history, progress, and dashboard totals. The
app writes or updates a readable Markdown export for each session under
`records/sessions/` as pages are confirmed and when the session finishes, and
regenerates a weekly summary under `records/weekly/`. Existing session exports
without the app's generated marker are preserved; the app writes a separate
dashboard summary rather than overwriting them.

Open **Study records** on the dashboard to browse session logs, Study Coach
conversations, and weekly summaries. Tabs separate the record types; session
logs and conversations can be filtered by topic and date range, and long lists
are paginated. In a session log, **Show page summaries** opens page summaries
and up to three key concepts per page separately from the session details.
Session exports show both the start and finish dates if a session spans more
than one day.

## Clear study records

To clear the study history from the portal, open **Study records**, select
**Clear study records**, review the summary, and confirm. The action removes
all saved sessions and their Coach conversations and exercise results, along with
Study Room generated session logs and weekly summaries. It keeps saved
PDF/video resume positions and manually written Markdown files. The app blocks
the action while a session is active or paused; resume and finish that session
first.

For a manual database cleanup, first stop Study Room with `Ctrl+C` in the
terminal running `./study`. From `~/learn`, make a full backup of the records
directory:

```bash
cp -a records "../learn-records-backup-$(date +%Y%m%d-%H%M%S)"
```

The `sqlite3` command-line program is optional and may need to be installed
separately. Open the SQLite database with:

```bash
sqlite3 records/study.sqlite3
```

In the SQLite prompt, review the sessions and delete them in a transaction:

```sql
SELECT id, topic_id, status, started_at
FROM sessions
ORDER BY started_at DESC;

PRAGMA foreign_keys=ON;
BEGIN;
DELETE FROM sessions;
COMMIT;
.quit
```

With foreign keys enabled, deleting sessions also deletes their related chat
messages and exercise results. This manual SQL procedure does not delete the
Markdown exports described below.

Markdown session exports and weekly summaries are files outside SQLite, so they
remain in the Study records reader after the database is cleared. To remove
those too, list the app-generated files and delete only the files you intend to
remove:

```bash
rg -l "Generated by the local Study Dashboard" records/sessions records/weekly
```

This process preserves `records/progress.json`, which stores the current PDF
and video resume cursors. The SQLite database is the structured source for
dashboard totals and Coach chat history. Topic folders under `topics/` are
separate from records and are not changed by the clear action.

## Codex tutor, sign-in, skills, and agents

The app uses plain HTML, CSS, and JavaScript in the browser, a Python
standard-library HTTP server, and SQLite. It does not use a web framework.

The browser chat is connected to a local Codex app-server. It uses ChatGPT
managed sign-in, not an API key. Sign in with the same ChatGPT account used for
Codex; tutor requests consume that account's Codex allowance and are subject to
its usage limits. If the local Codex CLI is already signed in, the app-server
may see that existing local sign-in; otherwise use **Connect ChatGPT** in the
dashboard. The app does not store an API key in the browser.

OpenAI documents app-server as the integration for custom clients that need
conversation history and streamed agent events, and documents ChatGPT-plan
OAuth for app-server inference. The app-server protocol is currently described
as experimental; this is a personal app bound to loopback, not a hosted service.
[Codex app-server](https://learn.chatgpt.com/docs/app-server) ·
[ChatGPT-plan usage with app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)

The Study Coach panel lets the learner choose an available text-and-image model
and one of that model's supported reasoning efforts. The choice applies to the
next chat response and PDF page read and is remembered in that browser.

For temporary verification, each accepted Coach turn prints its thread ID, turn
ID, requested model, and reasoning effort in the terminal running `./study`.
This confirms which settings the app sent and that Codex accepted the turn
start; it does not expose prompt text or independently verify the provider's
internal serving details. To disable this diagnostic, comment out the `print(`
call marked `TEMP` in `scripts/study_web/server.py` inside `_stream_turn`.

The existing `study-coach` skill is used for each new tutor thread. It contains
the teaching style, page-reading guidance, and test rubric; the app supplies
the selected topic, reference, duration, and starting position. `AGENTS.md`
sets workspace-wide preservation and logging rules. A separate autonomous
agent is not needed for a single learner and a single Study Coach. The dashboard
owns timer and database writes; the Codex thread runs read-only in the learning
workspace and coaches through the browser chat.

## References

Book PDFs are symbolic links into OneDrive, not copies. The browser serves the
selected linked PDF locally so it opens directly in a new tab. OneDrive may
hydrate an online-only PDF when first read. Video references open in YouTube at
the saved playback position.

| Topic | Reference | Workspace link or resource |
|---|---|---|
| Linux | Linux Bible (Blum) | `topics/linux/blum-linux-bible/blum-linux-bible.pdf` |
| Calculus | Stewart | `topics/calculus/stewart/stewart.pdf` |
| Electronics | Sedra/Smith | `topics/electronics/sedra/sedra.pdf` |
| Algebra | Grossman | `topics/algebra/grossman/grossman.pdf` |
| Networking | Kurose | `topics/networking/kurose/kurose.pdf` |
| Python | Fluent Python | `topics/python/fluent-python/fluent-python.pdf` |
| Go | O'Reilly Go | `topics/go/go-o-reilly/go-o-reilly.pdf` |
| C | Deitel C, 4th edition | `topics/c/deitel4/deitel-4th.pdf` |
| Algorithms | Grokking Algorithms | `topics/algorithms/grokking-algorithms/grokking-algorithms.pdf` |
| 3D modeling | FreeCAD robotic-arm walkthrough | [YouTube tutorial](https://www.youtube.com/watch?v=41OdocnsyXE) |
| 3D modeling | Blender robotic-arm rigging | [YouTube tutorial](https://www.youtube.com/watch?v=QqOShvk4Ne8) |

The linked OneDrive source paths remain recorded in `records/references.json`.
The selected book is currently one reference per book topic; new reference
books can be added later without changing the dashboard design.

## Topic folders

All local notes, exercises, environments, and linked books are organized in
`topics/<topic>/`. To add a topic, create its folder under `topics/` and add the
topic and references to `config/study-plan.json`; book paths in that file are
relative to the project root, so they start with `topics/<topic>/`. Video-only
topics can also have a folder for their local notes and project files.
