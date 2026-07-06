<p align="center">
  <img src="assets/icon.png" width="200" alt="Logo">
  <h1 align="center">Bowow - BETA</h1>
  <p align="center">The open source AI coding agent.</p>
</p>

<p align="center">
<a href="README.md">English</a> |
<a href="README.ar.md">العربية</a>
</p>

<p align="center">
  <a href="https://github.com/YASSER-27/Bowow/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-lightgrey.svg?style=for-the-badge" alt="License">
  </a>
  <img src="https://img.shields.io/badge/TypeScript-181818?style=for-the-badge&logo=typescript&logoColor=3178C6" alt="TypeScript">
  <img src="https://img.shields.io/github/actions/workflow/status/YASSER-27/Bowow/main.yml?style=for-the-badge" alt="Build Status">
  <img src="https://img.shields.io/badge/version-1.5.0-FF5A5F.svg?style=for-the-badge" alt="Version">
</p>

## Usage

1. Launch the app and open the Settings panel to configure your AI provider and API key, then click Done.
2. Connect to a model (Gemini, OpenAI, Ollama, etc.).
3. Open a project folder or start a new session.
4. Describe what you want to build — the agent will generate files, edit code, and run commands.
5. Use F10 to toggle split-screen mode for multi-session management.

<p align="center">
  <img src="assets_img/gif_bowow.gif" width="600" alt="Logo">
</p>

## Updates & Improvements

- Performance optimization: resolved lag issues and improved stability.
- New Settings window with a cleaner interface.
- RTL language support for Arabic text and input alignment.
- Refined UI with a modern layout.
- Persistence: chat sessions are now saved automatically.

## Features

- Multi-Model Support — Works with Gemini, OpenAI, OpenRouter, Ollama, and llama.cpp backends.
- Split-Screen Mode — Toggle a 4-pane view (F10) to manage multiple build sessions simultaneously.
- Live File Editing — The agent reads, writes, and diffs project files directly on disk.
- Checkpoint System — Undo file changes with checkpoint-based rollback.
- Context Management — Automatic conversation compaction and pruning to stay within model context limits.
- Error Auto-Retry — Detects transient errors and retries with exponential backoff.
- Responsive UI — Adaptive font sizing and layout across window sizes.
- Session Persistence — All builds, conversations, and files survive app restarts via file-based storage.
- MCP Tools — Experimental MCP tool integration is now available.
- System Prompt — Configure a custom system prompt for the AI persona.
- User Prompts — Create and manage multiple saved prompts.
- Terminal Commands — Restrict or guide the AI with terminal command policies.
- Auto-Update System — Check for and install updates from the Settings menu.

---

## Installation

```bash
git clone https://github.com/YASSER-27/Bowow.git
```

```powershell
irm https://raw.githubusercontent.com/YASSER-27/Bowow/main/scripts/install.ps1 | iex
```

```bash
npm install
npm run dev
```

## Production Build

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

## Desktop App (BETA)

Bowow is a desktop application for full-access development work.

## Keyboard Shortcuts

| Key | Action |
|---|---|
| F10 | Toggle split-screen / fullscreen |
| F12 | Toggle DevTools |
| Esc | Close Settings modal |

## License

MIT

BOWOW BY [YASSER-27](https://github.com/YASSER-27)

<p align="center">
  <img src="assets_img/bowow.png" width="70" alt="Logo">
</p>

| Key | Action |
|---|---|
| F10 | Toggle split-screen / fullscreen |
| F12 | Toggle DevTools |
| Esc | Close Settings modal |


[![License](https://img.shields.io/badge/license-MIT-lightgrey.svg?style=for-the-badge)](https://github.com/user/repo)


BOWOW BY [YASSER-27](https://github.com/YASSER-27)

<p align="center">
  <img src="assets_img/bowow.png" width="70" alt="Logo">
</p>
>>>>>>> 7c1a7fa (Update: Added new Version 1.5.0 Stable)
