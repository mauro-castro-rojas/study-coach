# Study Room

Study Room is a local Python web app with a browser-based PDF reader and a
Codex-powered Study Coach. The server uses Python's standard library. Browser
libraries are installed locally from npm when you set up a checkout; they are
not committed to this repository.

## Requirements

- Python 3.12 or newer
- Node.js 24 LTS and npm
- Codex CLI authenticated with ChatGPT for Study Coach features

For WSL, the project uses [nvm](https://github.com/nvm-sh/nvm) to select the
Node version in `.nvmrc`. If nvm is not installed, install it using its official
instructions, then open a new terminal or load `~/.bashrc`:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
source ~/.bashrc
```

From the project directory, install the selected Node version and the locked
browser dependencies:

```bash
nvm install
nvm use
nvm alias default 24
npm ci
```

`package.json` lists the direct npm dependencies; `package-lock.json` records
their exact resolved versions. npm downloads their code into the ignored
`node_modules/` directory. The app uses `@missing-elements/pdfjs-viewer` for
the PDF.js reader and KaTeX for math; `pdfjs-dist` is installed transitively by
the viewer package. That directory is never committed.

## Run

```bash
./study
```

The server prints the local dashboard address and opens it in the Windows
browser when available. Press `Ctrl+C` in the terminal to stop it. See
[docs/study-system.md](docs/study-system.md) for session, records, and data
details.
