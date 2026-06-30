<p align="center">
  <img src="resources/icon-256.png" alt="Agent Terminal" width="128" />
</p>

<h1 align="center">Agent Terminal</h1>

<p align="center">
  AI-powered terminal with multi-agent support, a Kanban board with two-way ClickUp/Jira status sync, scheduled AI dashboard briefings, automated code review, Insights chat, and git worktree workflows.
</p>

<p align="center">
  <a href="https://github.com/tomdekkpro/Agent-Terminal/releases/latest">
    <img src="https://img.shields.io/github/v/release/tomdekkpro/Agent-Terminal?style=flat-square" alt="Latest Release" />
  </a>
  <a href="https://github.com/tomdekkpro/Agent-Terminal/releases/latest">
    <img src="https://img.shields.io/github/downloads/tomdekkpro/Agent-Terminal/total?style=flat-square" alt="Downloads" />
  </a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue?style=flat-square" alt="Platform" />
</p>

<img width="1182" height="795" alt="image" src="https://github.com/user-attachments/assets/84d0bbde-9ce2-4bac-884e-d97c78cfb30a" />
---

## Features

- **Dashboard** — The default landing view. Create scheduled AI **Notices**: write a prompt (e.g. _"tasks that need priority today"_ or _"news & trends about Vietnam"_), pick a daily local time, and it auto-generates a Markdown briefing. Each Notice chooses its own data sources/tools — **ClickUp**, **GitHub** (`gh`), or **Web** (with optional URLs) — plus Run-now and enable/pause.
- **Kanban board** — Columns are your task manager's **actual statuses**, kept in **two-way 1-1 sync** with ClickUp: drag a card (or use the per-card status dropdown) to write the exact status back; external changes flow back via polling. **Hide/collapse** any column, see per-task **Release Version** chips, and drive Auto Code from card state.
- **Multi-project terminals** — Organize terminals by project with tabbed navigation and split panes; the sidebar tree mirrors the board's statuses, hide/collapse settings, and Release Version
- **Multi-agent support** — Plug-in architecture for AI agents: Claude, GitHub Copilot, Gemini, Aider, and Qwen — each with model selection and usage tracking
- **Insights (AI Chat)** — Chat with any supported agent from a dedicated view with session history and model selection
- **Code Review** — Automated PR code review across multiple lists with severity ratings, findings grouped by file, and configurable review intervals
- **QC Testing** — Quality check view for running and tracking test results
- **Task management** — Unified provider system supporting **ClickUp** and **Jira** — pick tasks, create branches, track status, and post comments
- **Time tracking** — Start/stop timer per terminal, automatically synced to your task manager
- **Team collaboration** — Shared workspace features for team-based workflows
- **Copilot usage tracking** — Monitor GitHub Copilot session turns, model info, and context window data
- **Git worktree support** — Isolate task work in dedicated worktrees, auto-cleanup on completion
- **Task completion flow** — Create PR, push to remote, or merge locally when done
- **Mobile remote control** — Control your terminal from your phone via QR code pairing
- **Usage tracking** — Monitor API usage across all providers with a built-in usage indicator
- **Service status** — Monitor the availability of configured services at a glance
- **Auto-update** — Get notified and update to the latest version from GitHub Releases
- **Terminal persistence** — All terminals (agent and plain shell) restore automatically on restart

## Download

Get the latest release for your platform:

| Platform | Download |
|----------|----------|
| Windows | [Agent-Terminal-Setup.exe](https://github.com/Dekkpro/Agent-Terminal/releases/latest) |
| macOS (Intel) | [Agent-Terminal.dmg](https://github.com/Dekkpro/Agent-Terminal/releases/latest) |
| macOS (Apple Silicon) | [Agent-Terminal-arm64.dmg](https://github.com/Dekkpro/Agent-Terminal/releases/latest) |
| Linux (AppImage) | [Agent-Terminal.AppImage](https://github.com/Dekkpro/Agent-Terminal/releases/latest) |
| Linux (Debian) | [agent-terminal.deb](https://github.com/Dekkpro/Agent-Terminal/releases/latest) |

### macOS Installation Note

The app is not code-signed with an Apple Developer certificate. macOS Gatekeeper may block it on first launch. To open:

1. Open the `.dmg` and drag **Agent Terminal** to **Applications**
2. Open **Terminal** and run:
   ```bash
   xattr -cr /Applications/Agent\ Terminal.app
   ```
3. Launch the app normally

Alternatively: right-click the app → **Open** → click **Open** in the dialog.

## Keyboard Shortcuts

| Action | Shortcut |
|--------|----------|
| Dashboard view | `Ctrl+D` |
| Terminals view | `Ctrl+T` |
| Kanban Board view | `Ctrl+K` |
| QC Testing view | `Ctrl+Q` |
| Insights (Chat) view | `Ctrl+I` |
| Code Review view | `Ctrl+R` |
| Settings view | `Ctrl+S` |
| New terminal | `Ctrl+N` |
| Switch project 1–9 | `Ctrl+1` – `Ctrl+9` |

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
- npm 9+

### Development

```bash
# Clone the repository
git clone https://github.com/Dekkpro/Agent-Terminal.git
cd Agent-Terminal

# Install dependencies
npm install

# Start in development mode (with HMR)
npm run dev
```

### Build

```bash
# Build for production
npm run build

# Package for your platform
npm run package:win     # Windows (.exe)
npm run package:mac     # macOS (.dmg)
npm run package:linux   # Linux (.AppImage, .deb)
```

### Release

```bash
# Bump version, tag, and push to trigger CI/CD
./scripts/release.sh patch   # or minor | major
git push origin Develop --tags
```

The GitHub Actions workflow builds for all platforms and publishes to [Releases](https://github.com/Dekkpro/Agent-Terminal/releases) automatically.

## Configuration

### Task Manager (ClickUp / Jira)

1. Open **Settings** (`Ctrl+S`)
2. Select a provider — **ClickUp** or **Jira**
3. Enter the required credentials (API token, Team/Project ID, etc.)
4. Test the connection
5. Tasks appear on the **Kanban board** (`Ctrl+K`)

### Dashboard (Scheduled AI Notices)

1. Open the **Dashboard** (`Ctrl+D`) — the default view
2. Click **New Notice** and write a prompt (e.g. _"list tasks that need priority today and why"_)
3. Choose the **sources** the AI may use:
   - **ClickUp** — your tasks from the configured list
   - **GitHub** — the `gh` CLI + a selected project's repo (PRs, issues, CI)
   - **Web** — web search/fetch, with optional pinned URLs (e.g. _"news & trends about Vietnam"_)
4. Set a daily run time (e.g. `08:00`) and enable the schedule
5. The Notice auto-generates a Markdown briefing at that time — or hit **Run now** anytime

> Tools are pre-approved per source so runs work unattended; a Web notice gets web tools but **not** shell access. Requires the `claude` CLI.

### Kanban Board

1. Open the **Kanban Board** (`Ctrl+K`)
2. Import tasks from the backlog, then drag cards between columns — each column **is** a ClickUp status, and moving a card writes that status back to ClickUp (reverts with an error if ClickUp rejects it)
3. Use the per-card **status dropdown** to change status without dragging
4. Use the **Columns** menu to hide statuses you don't need (e.g. `Closed`) or collapse them to a rail — your layout persists

### Insights (AI Chat)

1. Open **Insights** (`Ctrl+I`)
2. Select a provider — **Claude**, **GitHub Copilot**, **Gemini**, **Aider**, or **Qwen**
3. Choose a model from the provider's available models
4. Start a conversation — sessions are saved and can be resumed from the sidebar

### Code Review

1. Open **Code Review** (`Ctrl+R`)
2. Pick one or more lists (all selected by default) — every matching task is loaded
3. Reviews run automatically on a configurable interval or on-demand
4. PRs are analyzed for critical issues, bugs, suggestions, and code quality
5. Findings are grouped by file with severity ratings and inline code references

### AI Agents

Agent Terminal supports multiple AI agent providers through a plug-in system. Each agent can be invoked directly in a terminal session:

| Agent | CLI Requirement | Capabilities |
|-------|----------------|--------------|
| Claude | `claude` CLI | Chat, code generation, session resume |
| GitHub Copilot | `gh copilot` | Chat, usage tracking |
| Gemini | `gemini` CLI | Chat, code generation |
| Aider | `aider` CLI | Code editing, git integration |
| Qwen | `qwen` CLI | Chat, code generation |

### Terminal

Customize font family, font size, cursor style, scrollback buffer, and theme in Settings > Terminal.

## Tech Stack

- **Electron 40** — Desktop framework
- **React 19** + **TypeScript 5** — UI
- **Zustand 5** — State management
- **xterm.js 6** — Terminal emulation
- **Tailwind CSS 4** — Styling
- **Vite 7.3** + **electron-vite 5** — Build tooling
- **electron-builder 26** — Packaging & distribution
- **electron-updater 6** — Auto-updates

## Project Structure

```
src/
├── main/                # Electron main process
│   ├── index.ts         # Window creation, tray, menu
│   ├── updater.ts       # Auto-update logic
│   ├── ipc/             # IPC handlers
│   │   ├── terminal-handlers.ts
│   │   ├── task-manager-handlers.ts   # Unified task manager (ClickUp / Jira)
│   │   ├── git-handlers.ts
│   │   ├── insights-handlers.ts
│   │   ├── code-review-handlers.ts
│   │   ├── kanban-handlers.ts            # Kanban tasks + 1-1 ClickUp status write-back
│   │   ├── dashboard-handlers.ts         # Scheduled AI "Notices" runner + scheduler
│   │   ├── qc-handlers.ts
│   │   ├── team-handlers.ts
│   │   ├── usage-handlers.ts
│   │   ├── service-status-handlers.ts
│   │   ├── project-handlers.ts
│   │   ├── settings-handlers.ts
│   │   └── providers/                 # Plug-in providers
│   │       ├── clickup.ts             # ClickUp task provider
│   │       ├── jira.ts                # Jira task provider
│   │       ├── agent-registry.ts      # Agent discovery & registry
│   │       ├── agent-types.ts         # IAgentProvider interface
│   │       └── agents/                # AI agent implementations
│   │           ├── claude-agent.ts
│   │           ├── copilot-agent.ts
│   │           ├── gemini-agent.ts
│   │           ├── aider-agent.ts
│   │           └── qwen-agent.ts
│   ├── terminal/        # PTY management & persistence
│   ├── kanban/          # Local Kanban task store (snapshot + workflow state)
│   ├── dashboard/       # Dashboard Notice store
│   ├── insights/        # AI chat executor & session storage
│   ├── qc/              # QC testing logic
│   ├── team/            # Team collaboration
│   ├── usage/           # API & Copilot usage tracking services
│   ├── analytics/       # Analytics & telemetry
│   └── project/         # Project data store
├── renderer/            # React frontend
│   ├── App.tsx          # Root component & shortcuts
│   ├── components/
│   │   ├── dashboard/   # DashboardView — scheduled AI Notices
│   │   ├── terminal/    # TerminalView, TerminalPanel
│   │   ├── layout/      # Sidebar, ProjectTabBar
│   │   ├── kanban/      # KanbanView, KanbanColumn, KanbanCard, backlog, task detail
│   │   ├── insights/    # InsightsView, ChatMessage, ModelSelector, SessionSidebar
│   │   ├── code-review/ # CodeReviewView — automated PR review
│   │   ├── qc/          # QCView — quality check testing
│   │   ├── team/        # Team collaboration UI
│   │   ├── status/      # Service status indicators
│   │   ├── usage/       # UsageIndicator
│   │   ├── project/     # Project settings & management
│   │   ├── settings/    # SettingsView
│   │   └── updates/     # UpdateNotification
│   ├── stores/          # Zustand stores
│   └── hooks/           # Global event listeners
├── preload/             # Context isolation bridge
└── shared/              # Types, constants, utilities
```

## License

MIT &copy; Tom
