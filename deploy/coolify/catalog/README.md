# Coolify service catalog: draft pull request

Not submitted yet. Coolify's contribution guide
([Adding a service](https://coolify.io/docs/get-started/contribute/service))
requires **at least 1,000 GitHub stars** on the project, and the maintainers do
enforce it: they closed rustrak (#11531) with "The service repository needs to
have at least 1K stars". Folio had 56 stars on 11.10.2026, so this waits.

## Files for the pull request

| Here | In `coollabsio/coolify` |
|---|---|
| [`folio.yaml`](folio.yaml) | `templates/compose/folio.yaml` |
| [`folio.svg`](folio.svg) | `public/svgs/folio.svg` (the header says `logo: svgs/folio.svg`) |

Target branch: `main`. There is no `next` branch any more; the contribution
guide sends features to `release/v4.x`, but a bot retargets one-click service
PRs to `main` by itself (see #11561, #11508). Do not commit
`templates/service-templates*.json`: CI regenerates them and the PR-quality
check rejects them.

And, as a second pull request that Coolify requires and asks to link to the
first (the template PR cannot merge before it), in `coollabsio/coolify-docs`:

| Here | There |
|---|---|
| [`folio.mdx`](folio.mdx) | `content/docs/services/folio.mdx` |
| `folio.svg` | `public/images/services/folio-logo.svg` |

## Before submitting

1. Stars: 1,000 or more.
2. Publish a release whose version tag exists in ghcr. On 11.10.2026 ghcr has
   only `latest`, `edge` and `sha-*`; `v0.1.0` exists as a git tag but no image
   was built for it. Push a new tag (`vX.Y.Z`) so `publish-image.yml` runs.
3. Coolify forbids floating tags in templates ("Do not use latest"). Replace
   `${FOLIO_TAG:-latest}` in `folio.yaml` with that tag, for example
   `ghcr.io/evergreen-it-dev/folio:v0.2.0`.
4. Test the template the way Coolify asks: in a Coolify instance, **Docker
   Compose Empty**, paste `folio.yaml`, deploy, open the address. Take the
   screenshots the PR template asks for (adding, running).
5. Keep the header comments at the top (`documentation`, `slogan`, `category`,
   `tags`, `logo`, `port`).
6. The PR must come from an account that passes Coolify's `pr-quality` bot:
   GitHub account at least 30 days old, filled-in profile, "Allow edits by
   maintainers" ticked, the PR template kept with its Contributor Agreement,
   description under 2,500 characters, at most 2 emoji, at most 5 code
   references, a conventional title (`feat(service): add folio`), commit author
   equal to the GitHub account. Text for the PR is in
   `docs/promotion/deploy-templates.md`.

Checked locally 11.10.2026: `docker compose config` passes and the stack
(Folio, PostgreSQL, Redis) starts, Folio turns healthy and `/` and
`/api/health` answer 200.
