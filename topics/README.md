# Topic materials

Keep topic-specific notes, code, local environments, project files, and linked
reference books in a folder named `topics/<topic>/`. The configured topic key
and folder name can be different when the key uses a display slug, as with
`3d-modeling` and `3d_modeling`.

The dashboard reads topic names and reference paths from the SQLite study plan.
Reference paths are relative to the project root and begin with `topics/`. Add a
folder here and matching rows to the `study_topics` and `study_references`
tables when introducing another topic. Topic management through the web UI is
planned but not implemented yet.
