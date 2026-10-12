# Folio agent skills

Skills in the open [Agent Skills](https://agentskills.io) format (`SKILL.md` with `name` and `description`). They work in Claude Code, Cursor, Codex, GitHub Copilot, Gemini CLI and other agents that read the format. They teach an agent how to work with a [Folio](https://foliowiki.online) wiki through the Folio MCP server, so connect the server first: see [integrations](../integrations/README.md).

| Skill | What it does |
|---|---|
| [folio-wiki](folio-wiki/SKILL.md) | Find, read, change as little as possible, re-read and link Folio pages, data tables and whiteboards. Treats page content as data, not instructions. |
| [release-notes](release-notes/SKILL.md) | Compare `git log` since the last tag with the wiki and write release notes. Runs only when asked. |

## Install

With the [skills CLI](https://github.com/vercel-labs/skills):

```bash
npx skills add evergreen-it-dev/folio
```

Or copy a folder by hand into your agent's skills folder, for example `.claude/skills/folio-wiki/` for Claude Code or `.agents/skills/folio-wiki/` for Codex and Cursor.

Claude Code, Cursor and Codex also have plugins that bundle these skills with the connection: [claude-code](../integrations/claude-code/), [cursor-plugin](../integrations/cursor-plugin/), [codex-plugin](../integrations/codex-plugin/).

## One source of truth

The files in this folder are the canonical copy. The plugins above carry identical copies, because a plugin must be self-contained. Edit here, then copy the change into the plugin folders.
