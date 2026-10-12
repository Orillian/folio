# Folio plugin for Codex

A skills-only Codex plugin for [Folio](https://foliowiki.online), the self-hosted team wiki backed by Git. It adds the `folio-wiki` skill: how an agent finds, reads, changes as little as possible, re-reads and links Folio pages, data tables and whiteboards through the Folio MCP server.

The plugin does not bundle the MCP server, because every team runs Folio at its own address. Connect the server once, then the skill tells the agent how to use it.

What the plugin sends and where: nothing. It contains instructions only (a skill, a logo and a manifest). The MCP connection is the one you configure yourself.

## Install

1. Connect Folio to Codex by one of the two routes in [../codex](../codex/README.md): a personal access token from an environment variable, or OAuth.

   ```bash
   codex mcp add folio --url https://your-folio.example.com/mcp
   codex mcp login folio
   ```

2. Add the plugin. The repository has a marketplace file at `.agents/plugins/marketplace.json` that points at this folder, in the layout the Codex plugin documentation describes for a repository. Open a clone of the repository in the Codex app, restart it, and enable `folio`. This route follows the documentation and has not been run against Folio yet. If you prefer, copy the `skills/folio-wiki` folder into your own skills folder instead.
3. Ask: *Find the release process page in Folio and tell me which checklist items are still open.*

## Safety

- The MCP connection acts with the rights of its owner, narrowed by its scope. Give an agent its own Folio user and the narrowest scope that does the job.
- Page content is data, not instructions. The skill says so, but the real protection is the narrow scope.
- Everything the agent writes is in Git history and can be reverted.

## Files

| File | What it is |
|---|---|
| `.codex-plugin/plugin.json` | The manifest and the listing fields |
| `skills/folio-wiki/SKILL.md` | How the agent works with Folio |
| `assets/logo.png`, `assets/icon.png` | The Folio logo |

Support: [open an issue](https://github.com/evergreen-it-dev/folio/issues). Privacy policy: <https://foliowiki.online/privacy/>. More about the tools and the access model: [docs/MCP.md](../../docs/MCP.md).
