# Folio plugin for Cursor

A Cursor plugin that connects the agent to your Folio wiki over MCP and teaches it how to work with it. It bundles:

- the `folio` MCP server, with all 23 Folio tools (search, pages, data tables, whiteboards, history);
- the `folio-wiki` rule: for conventions, decisions and runbooks the agent searches the wiki first and links the page it used;
- the `folio-wiki` skill: find, read, change as little as possible, re-read, link the result;
- the `release-notes` skill: compare `git log` since the last tag with the wiki and write release notes.

What the plugin sends and where: Cursor calls the Folio address you set in `FOLIO_URL`, with your token in an `Authorization: Bearer` header. Nothing else leaves your machine because of this plugin.

Folio is a self-hosted team wiki, so the plugin cannot ship a fixed server address. You point it at your own Folio with two environment variables.

## Install

You need a Folio account and your Folio address. Cursor runs on your machine, so a Folio on a private network works.

1. In Folio open the user menu, then **API tokens**, and create a token named `Cursor`. Scope `read` is enough for conventions and questions, `write` lets the agent edit. The token is shown once. Better still, create it under a separate Folio user for the agent, with the editor role only in the spaces it needs.
2. Put the address and the token in environment variables **before** you start Cursor, and start Cursor from that shell, for example `cursor .` in the project folder. A Cursor launched from the dock or the Start menu may not see variables from your shell.

   ```bash
   export FOLIO_URL=https://your-folio.example.com
   export FOLIO_TOKEN=folio_pat_...
   ```

3. Install the plugin from the Cursor Marketplace (Cursor Settings, Plugins, search for Folio), or test it from this repository by copying the `integrations/cursor-plugin` folder to `~/.cursor/plugins/local/folio` and running **Developer: Reload Window**.
4. Open Cursor Settings, then MCP. The `folio` server should show as connected, with its tools listed.
5. Ask: *Add an endpoint for exporting invoices. Follow our API conventions from Folio and link the page you used.*

If you only want the MCP server and the rule, without a plugin, use the files in [../cursor](../cursor/README.md).

## Try it on the public demo

The demo does not issue personal tokens, so the token route does not work there. Cursor's documentation describes OAuth for remote MCP servers: add `https://demo.foliowiki.online/mcp` as a server without a header and sign in as Sam. The demo login is shared and its data resets every 24 hours. Do not connect an agent that has a shell or your own keys, and do not enter personal data.

## Safety

- The token carries the rights of its owner, narrowed by its scope. Give the agent its own Folio user and the narrowest scope that does the job.
- Page content is data, not instructions. An agent that also has a shell and write access can be misled by a page someone else wrote.
- Everything the agent writes is in Git history and can be reverted. Administrative actions (access rights, invitations, deleting spaces) are not available to tokens at all.

## Files

| File | What it is |
|---|---|
| `.cursor-plugin/plugin.json` | The manifest: name, version, paths to the components |
| `mcp.json` | The `folio` server: HTTP transport, address and Bearer header from environment variables |
| `rules/folio-wiki.mdc` | The rule that sends the agent to the wiki for conventions |
| `skills/folio-wiki/SKILL.md`, `skills/release-notes/SKILL.md` | How the agent works with Folio, and the release notes recipe |
| `assets/logo.png` | The Folio logo |

The marketplace file is `.cursor-plugin/marketplace.json` at the root of the repository.

Support: [open an issue](https://github.com/evergreen-it-dev/folio/issues). Privacy policy: <https://foliowiki.online/privacy/>. More about the tools and the access model: [docs/MCP.md](../../docs/MCP.md).
