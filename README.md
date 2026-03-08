# ProjectHub

Local desktop app to manage all your dev projects from one place. Start/stop servers, track tasks & bugs, and send prompts to Claude Code — all from a visual dashboard.

![ProjectHub Screenshot](https://raw.githubusercontent.com/MartinSC9/ProjectHub-landing/main/screenshot.png)

## Features

- **Project Dashboard** — See all your projects with status, tasks, and bugs at a glance
- **Server Management** — Start/stop dev servers (frontend, backend, mobile) with one click
- **Claude Code Integration** — Send prompts to Claude directly from the UI, see responses in real-time
- **Task & Bug Tracking** — Add, complete, and delete tasks and bugs per project
- **Favorites** — Mark projects as favorites for quick access
- **Dark/Light Mode** — Toggle between themes, preference is saved
- **Real-time Terminal** — See server output live via WebSocket
- **Persistent Data** — All project data saved locally in `projects.json`

## Requirements

- **Node.js** 18+ — [Download](https://nodejs.org/)
- **Claude Code CLI** — Required for AI prompts. You need an active Claude subscription.
  ```bash
  npm install -g @anthropic-ai/claude-code
  ```

## Installation

### Option 1: Run as web app (recommended to start)

```bash
git clone https://github.com/MartinSC9/ProjectHub.git
cd ProjectHub
npm install
npm start
```

Then open **http://localhost:4000** in your browser.

### Option 2: Run as desktop app (Electron)

```bash
git clone https://github.com/MartinSC9/ProjectHub.git
cd ProjectHub
npm install
npm run electron
```

This opens ProjectHub as a native desktop window.

### Option 3: Build installer (.exe)

```bash
npm run build
```

The `.exe` installer will be in the `dist/` folder.

## Setup your projects

When you first open ProjectHub, it comes with example projects. To configure your own:

### Using the UI
1. Open ProjectHub
2. Click on a project to see its details
3. Click the **status badge** to cycle through states (Unknown → In Progress → Paused → Done)
4. Add servers with the **"+ Agregar"** button (type: frontend/backend/mobile, command: npm run dev, port: 3000)
5. Add tasks and bugs from the input fields

### Using Claude Code
You can also ask Claude to configure everything for you! Open a terminal in the ProjectHub folder and run:

```bash
claude
```

Then tell Claude something like:

> "Read my projects.json and update it with my real projects. My projects are in D:/Projects/ — scan them and detect what framework each one uses, add the right dev server commands, and set their status."

Claude will read your file system and update `projects.json` automatically.

### Manual editing
Edit `projects.json` directly. Each project has this structure:

```json
{
  "id": "my-project",
  "name": "My Project",
  "path": "C:/Users/you/Projects/my-project",
  "description": "What this project does",
  "tags": ["react", "typescript"],
  "status": "in-progress",
  "servers": {
    "frontend": { "command": "npm run dev", "port": 3000 },
    "backend": { "command": "npm run server", "port": 5000 }
  },
  "tasks": [
    { "id": 1, "text": "Add authentication", "status": "pending" }
  ],
  "bugs": [
    { "id": 1, "text": "Login page crashes on mobile", "severity": "high" }
  ]
}
```

## Using Claude Code integration

The Claude Code section in each project lets you send prompts that execute in that project's directory. Examples:

- *"Fix the TypeScript errors in this project"*
- *"Add a dark mode toggle to the settings page"*
- *"Explain what the main API routes do"*
- *"Run the tests and fix any failures"*

**Note:** This requires Claude Code CLI installed and authenticated. The prompts run with `claude -p` in print mode (non-interactive).

## Tech Stack

- **Backend:** Node.js + Express + WebSocket
- **Frontend:** Vanilla HTML/CSS/JS (Google Material Design style)
- **Desktop:** Electron
- **AI:** Claude Code CLI

## License

MIT
