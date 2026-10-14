# Limitations

Deliberate limits and known gaps, so that you do not spend time looking for
what is not there.

## Platform

- **PostgreSQL and Redis are required.** Page content lives in Git, but the
  index, access rights and collaborative-editing state live in PostgreSQL.
- **No serverless hosting.** Folio needs a long-running process, a persistent
  disk and WebSocket connections.
- **No user groups, no SSO/SCIM, no end-to-end encryption of content.**
  Sign-in is by email and password, optionally with Google.
- **The built-in AI assistant needs a Cursor subscription** and sends the
  pages it works with to that service. The key can be a person's own, or one an
  administrator provides for a space or for the whole instance. Other providers
  are not supported yet. Without a key the rest of Folio works normally.
- **The public demo is shared and resets daily.** It is at
  <https://demo.foliowiki.online>: one login for everyone, data reset every
  24 hours. Tokens, Git and import, share links, invitations, publishing a
  space and the AI assistant are turned off there. Don't enter personal data or API keys. The
  demo uses the optional analytics hook: anonymous events (page kinds, space
  slugs), never page content; your own installation sends nothing.
- **One agent per space.** `.agent` customizes the assistant for a space; a
  space cannot have several differently configured agents.

## Content

1. **File names are Latin only**: the slug is `^[a-z0-9][a-z0-9-]*$`. A page
   title in any script is fine; the file cannot be renamed that way.
2. **A reader sees a whiteboard as a static picture** — the Excalidraw editor
   is not enabled for them.
3. **PDF and Office files are not editable and not searchable by content** —
   by title only.
4. **Page rights are not inherited by child pages**: restricting a parent
   leaves its children open. There is no "close the whole subtree" mode. On a
   public site this matters most: lock every page that must stay closed.
   An image or attachment stored in the repository is protected through the
   pages that link to it: it is hidden from a member only while every page
   linking to it is closed to them, and a file no page links to is open to
   every member of the space.
5. **Only `[text](path)` links and images are rewritten** when a page is moved
   or renamed; HTML tags (`<img>`, `<a>`) and reference-style links
   (`[x]: path`) are left as they are.
6. **Search has no stemming** — a compromise for several languages at once:
   different forms of a word are different words.
7. **Whiteboard reactions live in the board's live state, not in its file.**
   They are saved in the database with the board's real-time snapshot, not in
   the `.excalidraw.svg` file, so they are not in Git history and do not
   travel with the repository.
8. **A space over a whole repository writes an `id` into each page.** Without
   a root path, Folio adds an `id` to the front matter of every Markdown page
   that lacks one and keeps `<slug>.folio` in the repository root. Other
   tools' front matter keys are kept. A space bound to a folder (`docs/`)
   writes neither: ids stay in Folio's index.

## Git

9. **A remote repository can be connected only if it is empty** — otherwise
   the request is refused, with no silent merging of histories. To start from
   an existing repository, create the space by cloning it.
10. **History does not appear instantly** — the commit is made after about 90
   seconds of quiet. An immediate commit is available through the
   synchronization action.

## Agents

11. **Through MCP you cannot**: create an `index.md` for a folder, manage
    access rights, rename or delete a space. Those actions go through the
    interface only.

## Import

12. **Confluence import does not support every macro.** Pages, images,
    callouts, code, checkboxes and whiteboards are converted; other macros
    may be simplified or lost. Run a test import before moving a whole space.

## Offline

13. **Offline mode covers documents and whiteboards** that were opened on the
    device before. Data tables, forms, file uploads and templates need a
    connection, and so does opening Folio itself in a fresh browser session.

## Public sites

A space set to public is readable by anyone, without an account
([how it works](FEATURES.md#publish-a-space-as-a-website), [setup](INSTALL.md#public-sites)).

14. **No `robots.txt` and no sitemap** are generated for public sites, and
    their pages are not marked `noindex`: search engines may index everything
    that is public. To keep a page out, restrict it or take the space off the
    web.
15. **Rate limits are counted per server process.** The limits on downloads
    (`PUBLIC_EXPORT_PER_MINUTE`) and on questions to Folio AI, and the cache
    that maps hosts to sites, live in the memory of the process: a restart
    resets them, and a second process would count on its own. Public search and
    the other read routes have no per-address limit at all; a site that
    attracts traffic you do not control needs a rate limit in the reverse proxy
    or a CDN in front of it.
16. **Folio AI on a public site needs a key of the space or of the instance**
    (or `CURSOR_API_KEY`). Visitors have no key of their own, and whoever owns
    the key pays for their questions. Runs are Ask mode only. The space's
    `.agent` rules are part of every run, so a visitor can get them paraphrased:
    keep secrets out of them. A conversation belongs to the browser that
    started it; there is no sign-in on the site.
17. **Subdomains and custom domains are set up by the operator.** DNS records,
    certificates (a wildcard certificate for subdomains) and the reverse proxy
    rules are outside Folio, and the bundled HTTPS proxy serves only
    `FOLIO_DOMAIN` until you add blocks to its `Caddyfile`.
18. **A public site is read-only and anonymous.** No comments, page history,
    backlinks or notifications; a form can be viewed but not submitted; a
    whiteboard is a picture. A reader on a subdomain or a custom domain stays
    anonymous even when signed in on the main address.
19. **Publishing settings live in the database, not in Git.** A clone or an
    export of the repository does not carry them. They can be changed only from
    the browser, by a space or instance administrator: not with an API token,
    and not in the public demo.

## Known defects

20. **Emptying the trash** may leave a folder with nested pages inside the
    service trash folder.
