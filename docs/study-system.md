# Study Room

Study Room is a private, local browser app for self-paced lessons, a Codex-powered
Study Coach, a live timer, and durable learning records. It replaces the old
fixed weekday rotation; it does not set a mandatory hour or session length.

## Install, start, and stop

The Python server uses only the standard library, so no `pip` install or
requirements file is needed. The PDF reader and math renderer are browser
packages managed with npm. Install Node.js 24 in WSL and install dependencies
once after cloning or updating the repository:

```bash
nvm install
nvm use
nvm alias default 24
npm ci
```

The `.nvmrc` file selects the Node version. `package.json` declares the direct
packages, while `package-lock.json` pins their full dependency tree. npm stores
downloaded library code in the ignored `node_modules/` directory. Do not copy
those packages into `web/` or commit `node_modules/`.

If nvm is not installed in WSL, follow the official [nvm installation
instructions](https://github.com/nvm-sh/nvm#installing-and-updating). The
project's [README](../README.md) includes the WSL setup commands.

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
in `America/Bogota`. The npm-installed Mozilla PDF.js reader renders the
OneDrive-backed file in the page and keeps its built-in page controls. During a
PDF lesson, mark
a page as read after you finish it. Only that explicit action sends the current
page image and extracted text to Codex. The app saves the PDF viewer page, the
concise summary, and the detected concepts to the open session as soon as the
page is checked. Page changes alone are not sent. Page summaries are kept in
the session record, not shown as chat messages.
The raw PDF page image and extracted text are sent to Codex for that request;
Study Room does not keep a local copy of that scanned page image. Learners can
also paste their own screenshots into a page summary in either Study Coach or
manual mode. Those user-added images are saved as lossless PNG files under
`records/attachments/`, with image metadata in SQLite linked to the page summary
by its session ID and PDF page number. Markdown image links keep the screenshots
in place in the page summary and Study records. Removing an image link and
saving the summary removes that attachment.
If the page contains an actual book exercise, the Coach presents it in the
conversation and records its printed identifier.

The timer counts active study time and can be paused. A PDF lesson requires at
least one page marked as read before **Finish & log** is available. Finishing
automatically saves the checked pages, their summaries and concepts, book
exercises, and exercises requested in the Coach conversation. At finish, the
learner confirms the scanned PDF pages, enters a chapter/section range, and can
add more ranges if the reading crossed into another section. Page summaries can
be edited as Markdown and previewed before saving. Formula notation in summaries
uses TeX delimiters and is rendered by the npm-installed KaTeX library in the
preview, session records, and Coach conversations. Chapter boundaries are not
inferred automatically. Study records identify each summary with its chapter,
section, and PDF viewer page; printed page labels are omitted. The session
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

## Stored study data

The local SQLite database at `records/study.sqlite3` is the structured source
for the study plan, resume positions, and study records. `study_topics`,
`study_references`, `weekly_assessment_topics`, and `study_settings` define the
topics, materials, weekly order, timezone, and assessment duration.
`topic_progress` and `reference_progress` store the current PDF and video resume
positions. The `sessions` table stores session timing, status, topic and
reference IDs, positions, page ranges, concepts, exercise grades, assessment
scores, and Codex thread IDs. `page_reads` stores each PDF viewer page, its
summary and concepts. `messages` stores the Study Coach conversation, and
`exercises` stores exercise results. Assessment grades are fields on sessions,
not a separate database or directory.

Each page summary is keyed by `(session_id, pdf_page)` in `page_reads`. The
`page_images` table stores screenshot metadata and relative paths; image bytes
are PNG files under `records/attachments/<session-id>/`. PDF and video resume
positions live in SQLite. The app generates session Markdown exports under
`records/sessions/`. Weekly summaries are calculated from the session and
exercise rows in SQLite when opened in Study Records; no weekly summary file or
database copy is saved. SQLite remains the structured source of truth, so edit
summaries in the app; directly editing a generated session export is not a
reliable way to update the database, and a later app write may replace it.

These are local user data, excluded from Git. A fresh checkout creates its own
database and records; it does not include another learner's records. To move a
learner's data, back up and restore the records directory while Study Room is
stopped. Book PDFs are separate topic files or symbolic links; links into a
personal OneDrive path must be recreated on another computer. The app does not
currently use Docker. If it is containerized later, the records directory must
be mounted from persistent host storage or a Docker volume; data saved only in
a container's writable layer is not a backup.

`records/references.json` may exist from an earlier version, but current runtime
code does not read it. SQLite is the runtime source of truth. If an older local
`config/study-plan.json` or
`records/progress.json` exists, startup imports its values with inserts that do
not overwrite database values, records a migration marker for progress, and
removes the old JSON file after the database commit. Old scheduler files such as
`records/runtime/active-timer.json` and
`records/runtime/timer-events.jsonl` are not used by the current implementation;
current session timing is stored in SQLite.

Open **Study records** on the dashboard to browse session logs, Study Coach
conversations, and weekly summaries. Tabs separate the record types; session
logs and conversations can be filtered by topic and date range, and long lists
are paginated. In a session log, **Show page summaries** opens page summaries
and up to three key concepts per page separately from the session details.
Session exports show both the start and finish dates if a session spans more
than one day.

## Inspect SQLite from WSL

The Study Room server uses Python's standard-library `sqlite3` module; there is
no Python package to install. The interactive `sqlite3` command-line program is
a separate optional tool. In Ubuntu on WSL, install it with:

```bash
sudo apt update
sudo apt install sqlite3
sqlite3 --version
```

Run commands from the project root. Pass the database filename when starting
the console so it opens the persistent Study Room database:

```bash
cd ~/learn
sqlite3 -readonly records/study.sqlite3
```

At the `sqlite>` prompt, verify which database is open and list its tables:

```text
.databases
.tables
.schema sessions
PRAGMA table_info(sessions);
PRAGMA table_info(page_reads);
.quit
```

Dot commands such as `.tables`, `.schema`, `.open`, and `.quit` are SQLite
console commands. SQL statements such as `PRAGMA` and `SELECT` end in a
semicolon. To open the database after starting the console without a filename,
use `.open records/study.sqlite3`. Starting `sqlite3` with no filename creates
a temporary in-memory database; changes there do not affect Study Room. Use
`.databases` to verify the filename before any write operation. A `.sqlite3`
file is a binary database, so opening it as ordinary text in Neovim will not
show readable tables.

Read-only queries for the most common records:

```sql
SELECT id, topic_id, reference_id, mode, status, started_at, ended_at
FROM sessions
ORDER BY started_at DESC;

SELECT session_id, pdf_page, printed_page, length(summary) AS summary_characters
FROM page_reads
ORDER BY created_at DESC;

SELECT session_id, role, created_at
FROM messages
ORDER BY id;

SELECT session_id, exercise_id, outcome
FROM exercises
ORDER BY id;
```

Before manual database changes, stop `./study` with `Ctrl+C` and make a backup.
To back up the entire records directory, including Markdown exports and page
images, run this from the project root:

```bash
cp -a records "../learn-records-backup-$(date +%Y%m%d-%H%M%S)"
```

For a database-only snapshot, open the database in the regular (not
read-only) SQLite console and run `.backup /tmp/study-before-schema-change.sqlite3`.
The `cp -a records` command is the more complete backup because it also includes
the Markdown exports, resume-position file, and screenshot images.

Do not manually delete `study.sqlite3-wal` or `study.sqlite3-shm`. SQLite uses
these sidecar files while the database is in write-ahead-log mode; the WAL may
contain recent transactions. Let SQLite manage them.

## Clear study records

To clear the study history from the portal, open **Study records**, select
**Clear study records**, review the summary, and confirm. The action removes
all saved sessions and their Coach conversations and exercise results, along
with their pasted page screenshots and generated session logs. Weekly summaries
then disappear because they are calculated from those sessions. It keeps saved
PDF/video resume positions and manually written Markdown files. The app blocks
the action while a session is active or paused; resume and finish that session
first.

The portal action is preferred because it removes the database rows, attached
PNG files, and app-generated session Markdown exports together. A manual SQL
deletion affects only SQLite. It leaves the session exports and image files on
disk, even though their database links are gone.

If manually clearing SQLite only, stop Study Room, back up `records/` as
described in [Inspect SQLite from WSL](#inspect-sqlite-from-wsl), then open the
persistent database and verify it with `.databases`:

```bash
sqlite3 records/study.sqlite3
```

In the SQLite prompt, review sessions, then delete them in a transaction:

```sql
SELECT id, topic_id, status, started_at
FROM sessions
ORDER BY started_at DESC;

PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;
DELETE FROM sessions;
COMMIT;
.quit
```

Deleting sessions cascades to page summaries, Coach messages, exercise results,
and screenshot metadata. It does not delete screenshot PNG files or Markdown
exports. Prefer **Clear study records** in the portal when you want the related
files removed too. The action preserves PDF/video resume positions and manually
written topic Markdown files.

## Remove obsolete schema from an older local database

The current app does not create or use the old `metadata` table or the
`sessions.legacy` column. They may remain in a database created by an earlier
version. Inspect first with `.tables` and `PRAGMA table_info(sessions);`. The
following cleanup is only for a database where `metadata` exists and
`sessions.legacy` appears in that column list. Back up `records/`, stop the
app, and verify `.databases` points to `records/study.sqlite3` before running
schema changes. SQLite 3.35 or newer supports `DROP COLUMN`.

```sql
BEGIN IMMEDIATE;
DROP TABLE IF EXISTS metadata;
ALTER TABLE sessions DROP COLUMN legacy;
COMMIT;
```

If a statement fails before `COMMIT`, run `ROLLBACK;` before continuing. These
changes remove the obsolete import marker and column; they do not delete
session rows. Do not run `DROP TABLE sessions` or delete the database file to
remove the legacy marker.

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

During a session, **Codex usage** opens an on-demand panel with the quota windows
and token totals Codex reports for that Study Coach conversation. It loads only
when opened or refreshed. Codex may omit a quota window or token totals, so the
panel reports those as unavailable rather than estimating them.

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

The selected book is currently one reference per book topic; new reference
books can be added later without changing the dashboard design.

## Topic folders

All local notes, exercises, environments, and linked books are organized in
`topics/<topic>/`. Create the matching topic and reference rows in SQLite. The
web UI for adding topics is planned but not implemented yet. Book paths are
relative to the project root and start with `topics/<topic>/`. Video-only topics
can also have a folder for local notes and project files.
