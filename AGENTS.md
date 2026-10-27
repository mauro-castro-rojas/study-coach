# Study Room workspace

The local Study Room browser dashboard is the learner's entry point. Sessions
are self-paced: the learner chooses a topic, one reference, a lesson or
practice-test mode, and an optional time target. Do not enforce a fixed daily
time or topic rotation.

- Invoke the `study-coach` skill for in-browser teaching and topic-specific
  practice tests. One coach skill is sufficient; do not spawn additional agents
  for ordinary lessons.
- The browser dashboard and its SQLite store are authoritative for actual
  active study time, learner-confirmed page/video positions, exercise results,
  and assessment grades. The app generates one readable Markdown file per
  finished session and an updated weekly summary.
- The Codex app-server thread runs in read-only workspace mode. It teaches and
  reviews; it must not change study records itself. The dashboard writes data
  only after the learner confirms it.
- Books are OneDrive-backed symbolic links. Never copy, move, or modify source
  books, and do not scan pages automatically. Read and summarize a PDF page
  only after the learner marks it as read and the app supplies that page's
  content. Save page summaries and detected concepts in that session's record;
  present only actual exercises found on the shared page. Do not start lessons,
  retrieval questions, or exercises unless the learner asks. The Study Room
  composer accepts text only, so do not ask for screenshots or uploads there.
- Topic materials live under `topics/<topic>/`. Preserve existing user work,
  especially `topics/c/deitel4/`, `topics/python/grokking_algorithms/`, the
  calculus environment, Linux notes, and `topics/power_shell/`.
- `records/progress.json` stores the current PDF and video resume cursors. The
  dashboard continues to maintain those cursors; new session history is stored
  in SQLite and readable Markdown exports.
- Don’t invent requirements or add unrequested behavior. If important context 
  is missing or an implementation choice would change the requested behavior, 
  ask me before proceeding. Make reasonable assumptions only for routine 
  details that don’t affect functionality, and state them clearly.
- Keep CSS files human-readable: use one selector per rule, put each declaration
  on its own line, indent nested at-rules consistently, and separate rules with
  blank lines. Do not minify CSS or combine multiple rules on one line.
