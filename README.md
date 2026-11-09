# WebCross Skills

Official [Agent Skills](https://github.com/Aitheris/webcross-skills) for [WebCross](https://github.com/Aitheris/webcross) — a local-first browser control platform powered by the Agent Browser Control Protocol (ABCP).

These skills equip AI coding assistants and autonomous agents (such as Claude Code, Cursor, Windsurf, DeepSeek Harness, Antigravity, or custom agents) with the knowledge and best practices needed to reliably operate browsers, observe DOM state, handle human-in-the-loop interactions, and author deterministic, reusable workflows.

---

## Included Skills

| Skill | Focus | Key Capabilities |
| --- | --- | --- |
| [**`webcross-browser`**](./skills/webcross-browser/SKILL.md) | Browser Operation & Automation | • Fleet lifecycle and isolated session management<br>• Structured DOM observation, coordinates & semantic selectors<br>• Natural input simulation (click, type, hover, drag, scroll)<br>• Event listening, waiting, and download handling<br>• Human-in-the-Loop (HITL) takeover for 2FA, logins & CAPTCHAs |
| [**`webcross-workflow`**](./skills/webcross-workflow/SKILL.md) | Workflow Authoring & Verification | • Live-browser demonstration to code synthesis<br>• Multi-choice and judgment boundary detection<br>• Strict TypeScript generation for the QuickJS-NG WASI sandbox<br>• Sandbox resource validation (memory, stack, IO slots, deadlines)<br>• User-gated workflow persistence (`Workflow.upsert` / `Workflow.execute`) |

---

## Supported Integrations

WebCross Skills conform to the standard Agent Skill specification (`SKILL.md`). They integrate seamlessly across multiple agent environments and transport protocols:

- **Transport Protocols**:
  - **MCP (Model Context Protocol)**: Streamable HTTP connection over the ABCP MCP server.
  - **`webcross` CLI**: Local IPC command-line interface.
  - **WebSocket**: Direct local socket communication.
- **Compatible Agents**:
  - Claude Code
  - Cursor / Windsurf
  - DeepSeek Harness (DSH)
  - Google Antigravity
  - Any agent compatible with the open Agent Skills specification or MCP tools

---

## Quick Start

### 1. With WebCross Desktop Application (Recommended)

The WebCross desktop application bundles these official skills out of the box:

1. Launch WebCross.
2. Go to **Connection Management** or **AI Assistant Settings**.
3. Select your preferred agent (e.g., Claude Code, Cursor, DSH). WebCross will automatically configure the connection and sync the official skills into your agent's environment.

### 2. Standalone Agent Installation

You can also install these skills manually into any agent project that supports standard skill directories:

```bash
# Clone the skills repository
git clone https://github.com/Aitheris/webcross-skills.git

# Copy skills to your project's agent skills directory (e.g. .agents/skills/ or .claude/skills/)
cp -r webcross-skills/skills/webcross-browser /path/to/your/project/.agents/skills/
cp -r webcross-skills/skills/webcross-workflow /path/to/your/project/.agents/skills/
```

> **Prerequisite**: Ensure a WebCross instance is running locally with an active CLI, MCP, or WebSocket connection.

---

## Repository Structure

```text
skills/
├── webcross-browser/            # Browser operation & automation skill
│   ├── SKILL.md                 # Core instructions & task guidance
│   ├── agents/                  # Agent tool definitions & prompts
│   ├── assets/                  # Icons & visual identifiers
│   └── references/              # Connection recovery & orchestration guides
│
└── webcross-workflow/           # Deterministic workflow authoring skill
    ├── SKILL.md                 # Workflow authoring rules & sandbox constraints
    ├── agents/                  # Agent tool definitions & prompts
    ├── assets/                  # Icons & visual identifiers
    └── references/              # Async handling & segmentation guides
```

---

## License

This project is licensed under the [MIT License](./LICENSE).
