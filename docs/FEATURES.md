# Folio features

What Folio does today. Everything listed here works in the code; the limits
and exceptions are collected in [LIMITATIONS.md](LIMITATIONS.md).

## 1. The idea

Folio is a wiki whose **source of truth is a Git repository**, not a database.
Each space is a separate Git repository or a folder inside one. A page is a
file:

| Page kind | File | Editable |
|---|---|---|
| Document | `*.md` | yes, together |
| Whiteboard | `*.excalidraw.svg` | yes, together |
| Data table | `*.table.md` | yes, together |
| Form | `*.form.md` | yes |
| PDF | `*.pdf` | no, view only |
| Office | `*.docx`, `*.xlsx`, `*.pptx` | no, view only |

PostgreSQL stores the index, access rights, the activity history and the state
of collaborative editing — but not the content itself. Any page can be read
and changed directly in Git, and Folio picks the change up.

The title of a document is its **first `#` heading**, not the file name. PDF
and Office files are the exception: their title is the file name with the
extension.

## 2. Editor

Three modes, switched at the top right:

- **Reading** — the default when any link is opened;
- **Live edit** — editing with the markup rendered as you type;
- **Source** — plain Markdown.

A reader without edit rights sees Reading only.

**What can be inserted** (with `/` or the toolbar): headings, lists (bulleted,
numbered, checklist), a table, a code block, a **Mermaid diagram** (with a
visual editor), an image, a link, a quote, **callouts** (`> [!NOTE]`, `tip`,
`important`, `warning`), a collapsible details block, emoji, a divider, and
`::pagetree` — a live tree of child pages right in the text.

**Obsidian markup is read, not written.** A vault's notes look right in Folio:
the files are never changed, Folio only draws what is already in the text, in
Reading, Live and Source alike.

- `[[Note]]`, `[[Note|alias]]`, `[[Note#Heading]]`, `[[Note#^block]]` and
  `[[#Heading]]` are links to pages, resolved through the page index (the
  "shortest path" rules of Obsidian, case-insensitive) with one request per
  page, not per link. A click opens the page and scrolls to the heading or the
  block. A link to a page that does not exist is dashed; an editor gets
  "Create page “Note”" (a file `Note.md` in the current folder). The same on a
  public site, without the create offer.
- `![[photo.png|300]]` is an image with a width (`300x200` adds a height);
  `![[report.pdf]]` is a link to the file; `![[Note]]`, `![[Note#Heading]]` and
  `![[Note#^block]]` embed that note, section or block, read-only, under a link
  to its source. The server checks the reader's rights for the embedded page
  (`GET /api/pages/:id/embed`, with a public twin for public sites); embeds nest
  up to 3 levels, and a cycle (a page embedding the page it is already shown
  in) is cut with a note.
- Callouts: `> [!type]`, `> [!type]+` / `-` (foldable, `+` starts open),
  `> [!type] Title`, nested, any type in any case — an unknown type is drawn as a
  note, and GitHub's five alerts are the same component (Obsidian's `info`,
  `faq`, `danger` ... map onto the five looks).
- `%%comments%%` (inline and block) are hidden in Reading and in PDF/DOCX
  export, dimmed in Live, visible in Source, and left out of search. An unclosed
  `%%` stays text. A comment is not a way to keep something secret: the text
  stays in the file, in Git and in MCP.
- A `^block-id` at the end of a paragraph is a hidden anchor; `#tag` and `#a/b`
  are chips (a click opens Cmd+K with the query `tag:<tag>`; on a public site a tag is plain text); `$inline$` and `$$display$$` formulas are drawn with
  KaTeX, loaded only on pages that have one (invalid TeX stays as text).
- In PDF and DOCX a wikilink prints as its text, an embedded note as
  "[embedded: Note]", an embedded image as the image, a callout as a quote with
  its title, tags as `#tag`, and a formula as its TeX in code.

**Text formatting** — toolbar buttons and hotkeys: `**bold**`, `*italic*`,
`~~strike~~`, `==highlight==` (with a colour: `==text=={.green}`), `++underline++`.
Underline is markdown rather than an HTML tag pair, so it nests with bold and
italic in any order; old `<ins>`/`<u>` on existing pages still render underlined.

**Status tags** — a small coloured badge inside a sentence, like a Confluence
status lozenge: `:status[Done]{color=green}`. Six colours (grey, blue, green,
yellow, red, purple; grey is the default). Insert one from the toolbar, the
selection bar or the `/` menu, and click it to change the text or the colour.
The text is stored as typed and shown in capitals. Tags work in table cells,
are found by search under their text, are drawn as badges in PDF and DOCX
export, and arrive from a Confluence import as the same tag.

**Copy and paste** — copying or cutting in Live edit keeps the formatting: the
clipboard holds the selection as Markdown (plain text) and as rendered HTML, so
a pasted result keeps bold, links, highlights and status tags in Slack, Google
Docs or mail. Pasting such HTML into Folio turns it back into Markdown.

Also in the editor: pasting from Excel and Google Docs keeps tables and
formatting; `[[` picks a page (an ordinary relative link is written to disk,
not a private dialect); `@` mentions a person; an outline panel on the right;
a page cover and icon; image attachments.

A link to a Folio page is shown in Reading mode as the **page title**, not as
a URL.

## 3. Working together

Real-time collaborative editing (Yjs) works for **documents, tables and
whiteboards**: changes appear in every open tab at once, and you see who else
is present.

Authorship reaches the Git commit: the history shows who changed the page.

**Typed text is protected.** The editor and the shared document are compared
after every change and any difference is repaired, so text cannot stay on
screen only. The browser keeps a local copy of the page and deletes it only
once the server's own state shows that it holds your edits. When it does not,
the header shows **Not saved** and closing the tab asks for confirmation. A
page you may only view opens read-only. On the server, a failed write of the
page file is retried and the newer live state wins over the older file the next
time the page opens; page files are written atomically; and the text a live
page held is saved in a backup table before the server replaces all of it (a
file changed outside, an API or MCP body write, "Take the version from Git").

**Whiteboard reactions.** Selecting a single shape in Edit mode shows a reaction
button at its selection frame; the palette has eleven emoji (yes, no and in
progress marks first), each with a name on hover. Reactions appear as chips with a count just under the
shape, click a chip to add or remove yours, and the tooltip names who reacted.
They sync in real time, two people reacting at once both keep theirs, people
with the viewer role, or anyone in View mode, see them but cannot add any, and they are not part of the
board's SVG file or Git history.

## 4. Offline mode

Folio keeps working when the connection does not.

- **Documents and whiteboards you have opened on the device stay editable**
  without a connection.
- **A page or a whiteboard can be created offline.** It appears in the tree at
  once, marked as not yet synchronized, and opens and edits like any other.
- **Everything is kept on the device** — in the browser's storage — and
  **reaches the server by itself** when the connection returns: at the same
  address, with the same content, without duplicates.
- **Edits made offline are not lost** if you go to another page or close the
  tab: they are sent even if that page is never opened again.
- **An indicator in the header**: "Offline", "Weak connection", "Not synced:
  N", "Syncing…". While everything is fine it is not shown. A click opens the
  list of what is waiting and a "Sync now" button.
- If the server refuses to create the page (no rights, the space was deleted),
  the page stays on the device with the reason and a "Retry" button.
- The editor for whiteboards is fetched ahead of time, a few seconds after
  Folio opens, so a board can be created offline even if none was opened
  before.

Need a connection: data tables, forms, file uploads, templates, and a page
that was never opened on this device. Folio itself is loaded from the server,
so a browser closed without a connection cannot open it again until the
connection is back.

## 5. Git

- A space can be created empty, **cloned from a remote repository**, or
  connected to a repository later. Several spaces can live in one repository
  in different folders.
- Edits are written to disk immediately, and **the commit is made after about
  90 seconds of quiet** in the space. Right after saving, the history may
  still be empty.
- The synchronization state is visible in the interface: local, clean,
  syncing, ahead, behind, conflict, error — with the number of commits and who
  synchronized last.
- **Conflicts** are listed for the whole space.
- **"Take the version from Git"** — one button that brings the space into
  exact agreement with the remote branch. It is destructive by design (local
  changes are discarded), but the state is first saved into a backup branch
  `folio-backup/<timestamp>`, so it can be rolled back.
- **Front matter from other tools is kept.** Folio manages only its own keys
  (`id`, `order`, `status`, `icon`, `cover`); everything else — `title`,
  `sidebar_position`, `slug`, `tags`, `description` from Docusaurus, MkDocs,
  Hugo or Jekyll, comments, lists, quoting — stays byte for byte when a page is
  saved, copied or duplicated.
- **A light footprint in a product repository.** When a space is bound to a
  folder of a repository (a root path such as `docs/`), Folio does not write an
  `id` into the files — not on the first scan, not when a page is created or
  edited; the id lives in Folio's index and survives moves, renames, copies and
  restores from the trash. The space's metadata file goes inside that folder as
  a dotfile, `docs/.<slug>.folio`, which site generators ignore, not into the
  repository root. Spaces that already carry ids in their files keep working
  as they are.
- **An Obsidian vault connects without changing a single file.** When the
  repository (or the folder you pick) contains `.obsidian/`, the "new space"
  dialog says so. A space made from a repository that already has files of its
  own is created with a light footprint by default, with or without
  `.obsidian/` (a gitignored `.obsidian`, a plain notes repo, a GitHub Wiki),
  even if it is the whole repository; only an empty repository and one that
  already was a Folio space (`<slug>.folio` at its root) get the native mode: no `id` is written into the files, the metadata file is
  a dotfile (`.<slug>.folio`) at the root, and `git status` stays clean after
  the scan. The "Light footprint (no ids in files)" checkbox can also be turned
  on by hand, in that dialog and later in the space menu ("Indexing & files…");
  a space bound to a sub-folder is always light. Existing spaces that carry ids
  in their files are not changed.
- **What the scan skips is set per space.** `.obsidian/`, `.trash/` and `.git/`
  (like every other dotfile or dot-folder; `.agent` at the root is the one
  exception) and the `assets` folder are always skipped. A space administrator
  can add their own entries: names of **top-level** files and folders, `*` for
  any characters, a trailing `/` for folders only (`Templates/`, `draft-*`),
  up to 50, case-insensitive. Saving a changed list re-indexes the space — pages
  under a newly skipped entry leave the index, pages under a released one enter
  it — and never touches the files. Space menu → "Indexing & files…", or
  `PATCH /api/spaces/:space/scan-settings`.
- **Obsidian wikilinks are indexed and follow renames and moves.** `[[Note]]`,
  `[[Note|alias]]`, `[[Note#Heading]]`, `[[Note#^block]]`, `![[Note]]` and
  `![[image.png]]` (outside code blocks and inline code) count as links: they
  appear in backlinks and in the unresolved-link list. They are resolved the way
  Obsidian does ("shortest path when possible"): a name without an extension
  means `name.md`; a path is tried from the page's folder, from the space root,
  and as the tail of a longer path; a bare name finds the one page of that name
  anywhere (with several, the one nearest to the page's folder); case does not
  matter; `%20` is read both literally and decoded. When a page is renamed or
  moved, the wikilinks that point at it are rewritten in the same form —
  `[[Old|alias]]` becomes `[[New|alias]]`, `#heading`, `#^block` and the `!` of
  an embed stay; a bare name is left alone when a move keeps it unambiguous, a
  `[[folder/page]]` path follows the page, and an explicit `[[../page]]` also
  follows a page that moved itself. Nothing else in the file changes. Folio
  does not create wikilinks (the `[[` picker in the editor still inserts a
  relative link), but it shows them (see section 2).
- **Page history**: the list of commits and a view of any revision. For a
  PDF or Office page each version shows its file name and size, can be
  downloaded (a PDF can also be previewed), and can be restored.
- Separately from Git there is **undo for structural actions** (create, copy,
  rename, move, delete) — your own only, and only if nothing has changed
  since.
- **Git access** (user menu): saved tokens for GitHub and GitLab are used
  automatically for repositories on the same host, and list your repositories
  in the "create space" dialog. On an instance with a GitHub OAuth App
  configured, **"Connect with GitHub"** saves github.com access in one click
  instead of pasting a token (see `INSTALL.md`).

## 6. Access

- **Roles in a space**: `admin`, `editor`, `viewer`.
- **Space visibility**: `private` (explicit members only), `instance` (any
  active user may view) or `public` (any active user may view, and anyone on
  the internet may read it as a website, see section 7).
- **Rights on a single page** can be narrower than the role in the space.
- **The instance administrator does not see the content of spaces** they are
  not a member of: they manage users and invitations, but the pages are closed
  to them. They can grant access to themselves — and that is written to the
  audit log and shown with a mark.
- **Invitations** — links with preset roles, an expiry date and a usage limit.
  A signed-in person can accept one with the current account, or sign out to
  use another account.
- **Access requests**: a user who runs into a 403 sends a request; the space
  administrators are notified and decide.

## 7. Sharing outside

A link to a page for people without an account: view or edit, optionally
"with child pages". There is also a `.md` form of the link that returns plain
Markdown — convenient for external agents.

"With child pages" never includes a page that has its own access
restrictions, nor anything below it: such a page is shared only by a link
made for that page itself. This is checked on every visit, so restricting a
page later also removes it from links that already exist. Of the space's
files, a guest gets only those of the pages the link covers and the images
and attachments those pages embed or link to. A link is a credential, so
links are listed, created and revoked only in the browser, never with an API
token.

Edits made by a guest through such a link reach Git with the matching
authorship.

### Publish a space as a website

Setting a space to **public** ("Publish as website" in the space menu, for space
and instance administrators) serves it to anyone, without signing in, as a
read-only site. It is the same space, not a copy. People who are signed in read
it exactly as they read a space with `instance` visibility.

- **Three addresses.** `<PUBLIC_URL>/public/<space>` works as soon as the space
  is public. `<label>.<PUBLIC_SITES_DOMAIN>` works when the operator has set
  `PUBLIC_SITES_DOMAIN` and the administrator picked a label (lowercase
  letters, digits and hyphens). A custom domain such as `docs.example.com`
  works when the host has a CNAME to the instance and the reverse proxy routes
  it to Folio. A subdomain and a domain belong to one space each. The
  operator's part is in [INSTALL](INSTALL.md#public-sites).
- **What a visitor sees.** The page tree, breadcrumbs, search inside the space,
  documents, data tables (live, read-only), whiteboards as pictures, forms
  (view only: submitting needs a Folio account), PDF and Office files, the
  images and files that public pages use. On a phone the tree folds behind a
  menu button. The footer has "Powered by Folio" and "Sign in" links.
- **Downloads** (opt-in per space): a page as Markdown, PDF or DOCX. PDF and
  DOCX are rate limited per address (`PUBLIC_EXPORT_PER_MINUTE`, default 6); a
  visitor's search query is cut at 200 characters.
- **Ask Folio AI** (opt-in per space, see section 11).
- **Never published**: pages with their own access restrictions, the `.agent`
  folder and templates. A restriction is not inherited by child pages, so each
  page that must stay closed needs its own lock. A raw file is served only if a
  public page uses it. Visitors are not sent the names or cursors of the people
  editing, and there are no comments, history, backlinks or notifications on
  the site.
- **Control.** Only administrators change visibility and publishing settings,
  from the browser (an API token is refused; the public demo allows it for the
  Folio Handbook, without a subdomain or a custom domain). The
  decisions about publication (who sees the site, its addresses, downloads,
  Folio AI, indexing, the primary address) live in the database, not in Git;
  changes are written to the audit log. Moving a space back to `instance` or
  `private` takes the site down within seconds, and the settings are kept for
  the next publication.
- **Site & PDF settings and the `.folio/` folder.** How a space presents itself
  outside the app lives in the repository, in a `.folio/` folder at the root of
  the space's content (`docs/.folio/` for a space with a root path), and one
  page edits it: space menu, **Site & PDF settings…**, at `/s/<space>/settings`
  (space administrators). Tab **Site**: title, tagline, description (the
  default meta description), language, social image, favicon and logo, with a
  preview as a search result and as a link card, next to a summary of the
  publication. Tab **Site appearance**: the site's stylesheet with a live
  preview. Tab **PDF**: header, footer and print stylesheet, and a "Test PDF"
  button. The files are `site.json`, `site.css`, `export.css`, `pdf-header.html`,
  `pdf-footer.html` and `assets/` (png, jpg, webp, gif, svg, ico, woff, woff2;
  up to 1 MB a file and 5 MB in total). Each file shows its path and an "Open
  in repository" link. Every save is one commit, `settings: update
  .folio/<files>`, with only those files in it, so unsaved page edits of other
  people are not swept into it. Git is an equal editor: if a file changed in
  the repository after the page was opened, the save is refused with a 409 and
  the page shows the difference and offers the repository's version or yours.
  PDF settings from before (the `export` section of `<slug>.folio` and
  `<slug>.export.css`) are still read, and the first save of the PDF tab moves
  them into `.folio/` in one commit. The "Powered by Folio" footer is not
  configurable.
- **Site stylesheet.** `.folio/site.css` applies to the public site only, never
  inside the app. Before it is served, comments and `@import` are removed,
  `url()` keeps only `data:` images and fonts and files from `.folio/assets/`
  (anything else becomes `none`) and a file over 256 KB is not applied; the
  editor shows the same warnings. Stable selectors are `.folio-site` and
  `[data-folio-site-part="header|sidebar|main|footer|page"]`. No JavaScript and
  no third-party snippets.
- **SEO.** The server renders a `<head>` for every public page: title (page
  title, then site title), description (the page's front matter `description`,
  else the site's, else an excerpt), Open Graph (`og:site_name`, `og:url`,
  `og:image` from the front matter `image` or `cover`, else the site's social
  image), a canonical link, `lang`, the favicon, and `noindex` for a page with
  `unlisted: true`. A page that is not on the site answers with a real 404.
  `robots.txt` and `sitemap.xml` are served per host: a site's host gets its
  own sitemap and keeps crawlers out of `/s/`, `/share/` and `/api/` (except
  `/api/public/`); the main host keeps them out of the app, lists the sitemaps
  of sites served at `/public/<space>` and serves each at
  `/public/<space>/sitemap.xml`. A sitemap lists the public pages that are not
  `unlisted`, with `lastmod`. The publishing dialog has an "Allow search engines
  to index this site" switch (on by default; off means `noindex`, `Disallow: /`
  and no sitemap) and a "Primary address" (automatic: custom domain, else
  subdomain, else the address on this Folio; or one of them) that the canonical
  links and the sitemap use. The site answers on every address; only the
  canonical one is declared. In the public demo every site is `noindex`.
- **Not yet.** There is no PDF preview before saving, no editor for the SEO
  fields of a single page (they are front matter keys), no redirect from the
  other addresses to the primary one, and no place for analytics snippets.
  Rate limits are counted per server process.

## 8. Search and navigation

- **Full-text search** across documents and tables.
- **Cmd+K** — quick switch between pages.
- The space switcher has search and scrolls long lists inside its menu.
- Recent pages, favorites (a star on a space and on a page), **backlinks**.
  The API returns one entry per link, with its syntax, anchor, line and the
  line of text around it as context.
- **A page index.** Every page is parsed once, with a real Markdown parser,
  when it is scanned and when it is saved: headings (level, text and the same
  anchor the outline uses), block ids (`^id`), tags (`#tag` and `#a/b` in the
  text, outside code and links, plus `tags:` in the front matter (`labels:` is read as a synonym; Folio never removes or moves it)),
  the whole front matter as properties, and links of every kind —
  `[text](path)`, images, `[[…]]`, `![[…]]`, HTML `<a href>` / `<img src>` and
  reference-style `[x]: path` — with their `#heading` / `#^block` anchor and
  whether that anchor exists. Links are resolved in a second step for the
  whole space, so a page created later picks up the links that were waiting
  for it, and deleting a page turns the links to it into unresolved ones
  instead of dropping them (restoring it from the trash resolves them again).
  REST: `GET /api/pages/:id/meta`, `GET /api/spaces/:space/tags`,
  `GET /api/spaces/:space/unresolved-links`, and `GET /api/spaces/:space/orphans`
  (pages nothing links to); MCP: `get_page_metadata`, `list_unresolved_links`,
  `list_orphans`. Access is applied inside the query, as in search: tag and
  backlink counts never include pages you cannot open, and a link to such a
  page looks like a link to nothing. The interface for all this comes in the
  next waves.
- A **tree** with drag and drop, a templates folder for creating "from a
  template", and the `.agent` folder (see section 11). The tree updates by
  itself.
- **Moving or renaming a page keeps links working**: relative links and images
  inside the page (and its subtree) are recalculated for the new location, and
  links to it from other pages are rewritten. The change is one commit,
  `docs: move <old> -> <new>` (`docs: rename …` for a slug).
- A **welcome wizard** for someone with no space yet: choose a document, a
  whiteboard or a data table to start with, read a short overview of Folio and
  of the assistant, and the first space is created with that page open. The
  same tour is in the account menu ("Welcome tour") at any time; with spaces
  already there it creates the page in the one you were last in.
- **Duplicate** and **Copy to…** in the page menu. Duplicate puts a copy
  next to the original, child pages included; Copy to… puts it under any
  page of any space you can edit, with or without the child pages. Every
  copied page gets an identity of its own. A copy takes only what you can
  open: a page with access restrictions that hide it from you is left out
  together with everything below it and the files only such pages use, and the
  `.agent` folder is never copied for someone who is not an administrator.
  The copy of a page that has its own access rules is private to the person
  who made it.

### Properties, tags, search operators and space files

- **Properties panel** (collapsed by default): the page's front matter keys with
  types `text`, `number`, `checkbox`, `date`, `datetime`, `list`, `tags`,
  `aliases`. Types come from `.folio/properties.json` in the repository, or from
  `.obsidian/types.json` when that file is absent. Saving rewrites only the front
  matter block; every other byte of the file stays. `id` cannot be changed, and a
  Folio key holding a value Folio would not write itself (`status: deprecated`)
  is shown as a foreign value and never overwritten. **Reading mode is read-only:**
  properties are shown there, and added, edited or removed in Live and Source.
- **Properties on data tables, forms, boards and files** (PDF, Office): the same
  panel, as a thin row above the page with "Properties (N)" at its top left.
  A table or a form keeps them in its own front matter, next to Folio's reserved
  keys (the table schema, the form fields): those are never shown, never edited,
  and a table or form save never drops the properties. A board or a file keeps
  them in a sidecar, `.folio/<path>.props.yaml` (`docs/report.pdf` →
  `.folio/docs/report.pdf.props.yaml`): created with the first property, deleted
  with the last, one commit per save, and it follows the page through renames,
  moves, the trash and a restore. Their tags and properties work in search
  (`tag:`, `prop:`) and in MCP `get_page_metadata`; whoever can edit the page can
  edit them.
- **Tags:** a tag tree in the sidebar (`a/b` nests), a list of a tag's pages and a
  **bulk rename** (`#tag` in the text and `tags:` in the front matter, plus the
  tags of tables, forms, boards and files, only on pages you can edit). `labels:` is a synonym of `tags:`: new tags are written as `tags:`, an existing `labels:` is only ever edited in place, never moved or removed.
- **Search:** words, `"exact phrase"`, `-word`, `tag:`, `in:folder/`, `kind:`,
  `status:`, `prop:key=value`, plus **saved searches** (up to 50 per person) in Cmd+K.
- **Space files** are indexed as files: attachments and `assets/` are not in the
  tree or in search, but links to them are resolved, counted in backlinks and
  reported when missing.

## 9. Data tables

A table is a small database inside the wiki.

Markdown tables inside documents have narrow, medium and full-viewport width
modes. Narrow and full-width tables can be resized from their highlighted
right edge; a table wider than the viewport scrolls horizontally inside its
own container.

- **Column types**: text, long text, number, date, checkbox, select, status,
  user, link.
- **Views** — tabs with their own set and order of columns, widths, sorting by
  several columns, a filter tree (`and`/`or`) and pinned columns.
- **Filters** including "me", "today", "this week", "last N days".
- **Limits**: 20,000 rows, 80 columns, 50,000 characters in a cell, 500 options
  in a list, 50 views. A table above the row limit **opens read-only** instead
  of breaking.

## 10. Forms

A small counterpart of Google Forms that writes answers into a data table. A
form and a table are linked one to one: a form field is a table column.

A form can be made public, so that people answer without an account. That
needs **both** the "public" flag **and** a valid share link to the form.
Anonymous answers are rate-limited.

## 11. Folio AI

An assistant in the side panel with two modes: **Ask** (read only) and
**Agent** (read and write). Each person adds a Cursor API key in their account
settings, or an administrator provides a shared one (see "Who pays" below).

The assistant uses **the same set of tools** as external clients do through
MCP (section 12). In Ask mode the write tools are unavailable, and that is
checked on the server, not only in the interface.

**Your own agent in every space — `.agent`.** A folder of ordinary pages in
the space, visible to and editable by space administrators only. Everything in
it — the agent's role, tone, glossary, rules, templates — is added to every
assistant run in that space, in Ask and Agent modes alike. Each space can
therefore have an agent of its own, and its instructions are versioned in Git
like any other page. About 60,000 characters of instructions are used; if
there is more, whole pages at the end are left out and the assistant is told
so.

**Answer quality and analytics.** Every saved assistant answer can be rated
👍 or 👎 (one rating per answer, changeable). After every third answer in a
conversation the panel asks "Did the assistant solve your question?" (Yes,
Partly, No, Not now, with an optional comment). The assistant also records
questions it could not answer or was unsure about, with the reason ("No
answer" or "Not sure") and what was missing, with links to the pages it read;
it does this through a built-in
tool that never changes any data, in Ask and Agent modes alike. Instance
administrators see the results at `/admin/assistant` ("Assistant analytics" in
the account menu): a **Conversations** tab with ratings and survey counts per
conversation, and a **Questions without an answer** tab (the person's own
question first, the assistant's wording second), both filtered by space, user
and date, with space names rather than slugs. A space administrator sees the
same page limited to the spaces they administer, and only the messages of runs
in those spaces. An administrator can open a conversation; opening one is
recorded in the audit log, and the conversation page shows who opened it and
when. Everyone else does not see the page, and a personal access token is
refused there.

**Bring your own subscription.** The assistant runs on a subscription you
already have. Cursor is supported today; other providers are coming soon.

**Who pays: personal, space and instance keys.** A run uses the first key that
exists, in this order: the person's own key, the key of the space the question
is asked in, the key of the instance, `CURSOR_API_KEY` from the server
environment. A space administrator sets the key of a space (space menu, "Folio
AI key"); an instance administrator sets the instance key (the "Shared key"
tab of Assistant analytics) and can turn personal keys off so that everyone
uses the shared one: a stored personal key is then ignored and the form for
adding one is hidden. The assistant settings show
whose key is in use. Shared keys are encrypted with `FOLIO_SECRET`, never
returned by the API (only the key's name, the Cursor account and who set it
and when) and every change is written to the audit log. The public demo
cannot change them.

**Ask Folio AI on a public site.** A space administrator can let visitors of a
published space ask questions (opt-in per space; "Ask AI about this space" on
the site). Visitors are anonymous. The run is **Ask mode only**, confined to
that one space and to its public pages: it cannot write, cannot read page
history, and a page that is restricted, in `.agent` or a template is "not
found" to it, like any other page that does not exist. It uses the key of the
space, else of the instance, else `CURSOR_API_KEY`; the owner of that key pays,
and without any key the site says Folio AI is not set up. A conversation is
tied to the browser that started it by a random token (only its hash is
stored). Questions are rate limited per address and per site
(`PUBLIC_ASSISTANT_RUNS_PER_HOUR`, default 20; `PUBLIC_ASSISTANT_SPACE_RUNS_PER_HOUR`,
default 200) and appear in the analytics as "Public visitor". The space's
`.agent` rules are part of every run, public ones included: do not put
anything secret in them.

Runs live **on the server**, not in the browser tab: close the browser and the
work continues; come back and read on from where it stopped.

## 12. Integration for external tools (MCP)

The `/mcp` endpoint with a personal access token (`folio_pat_…`), scopes
`read` and `write`. 26 tools: listing spaces and trees, reading a page,
search (plus `search` and `fetch` for ChatGPT deep research), creating and updating pages, resolving a Folio link, backlinks
with context, a page's metadata (outline, tags, properties, links), a space's
unresolved links and orphan pages, history and reading a page at a given
commit, working with whiteboards, and a full set of operations on data tables.
See [MCP.md](MCP.md).

## 13. Import, export and the rest

**Privacy of the installation.** Folio sends no telemetry. An optional hook for
a PostHog project of your own (`FOLIO_POSTHOG_KEY`) exists for people running
a public demo; with no key set, no analytics library is loaded and no
connection is opened. **Link previews:** the front page carries Open Graph and
Twitter card tags (title, description, 1200x630 picture), neutral by default
and set with `FOLIO_OG_TITLE`, `FOLIO_OG_DESCRIPTION` and `FOLIO_OG_IMAGE`.
See [INSTALL](INSTALL.md).

- **Import from Confluence**: a page or a tree, converting panels into
  callouts, code, checkboxes, status macros (as status tags), underline and
  images; the imported root never replaces the space's home page; Confluence **whiteboards** become
  Excalidraw boards.
- **File upload**: images, and also pdf/docx/xlsx/pptx — they become pages in
  the tree.
- **Images in the repository**: a space admin can turn on "Store images in the
  repository" (space menu → Image storage). New pasted or dropped images then go
  to `assets/` in the space's folder (`docs/assets/` for a space with a root
  path), are committed with the page, and are linked by a **relative** path
  (`../assets/diagram.png`), so they also show on GitHub. By default images are
  kept in Folio's storage; images already in pages do not move.
- **Replace a file page with a new version**: the tree menu item "Replace with
  new version…", a button in the page header (editors), or a file dropped
  on the open page. The page keeps its id, link, place in the tree, access and
  stars; a different file type renames the file and rewrites links to it.
  Every replace is a commit of its own, an "Undo" toast restores the previous
  version, and the history panel restores any older one.
- **Export**: `md`, `pdf`, `docx`, `yaml`, print, and a zip of the whole
  space. Export with child pages and custom page headers and footers for a
  space are supported (set on the **PDF** tab of the space's Site & PDF
  settings, see section 7). If an export had to be cut by size, the response
  headers say so.
- **Trash** with restore. Deleting a page that has children takes them along,
  and restoring brings them back.
- **Notifications** about access requests, delivered instantly.
- **Interface languages**: English and Ukrainian; a new language is a set
  of bundle files. Content is not translated — it is data.
- **Theme**: light, dark, system.
- **Mobile**: responsive layout, a separate mobile mode for tables. There is
  no separate app.
