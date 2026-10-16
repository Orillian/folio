# Link previews in Slack and Microsoft Teams

Paste a link to a Folio page into Slack or Teams and the message shows a card:
the page's icon and title, where it sits (`Space / Parent / Page`), the first
lines of its text, its section headings, its tags and when it was last updated
(and by whom). A data table shows its row count and columns, a form its number
of fields, a whiteboard or a file says what it is. An **Open in Folio** button
goes to the page.

Without this integration Slack and Teams fetch the link like any visitor
without a session, so every link shows the same generic "Folio" card. The
previews below are built with the Folio account of the person who shared the
link.

## What people see

- **The first time** someone shares a Folio link, Slack shows them, and only
  them, a short message with a **Connect Folio** button; Teams shows a
  **Connect Folio** sign-in in the compose box. They sign in with Slack (Slack)
  or in the Teams sign-in window (Teams), then sign in to Folio and approve
  read access on Folio's own consent screen. In Slack, the message they just
  posted gets its preview right after they connect.
- **From then on** their Folio links unfurl by themselves.
- A page they **cannot open** in Folio (or that does not exist) gets a card that
  says "Folio page" and nothing else: no title, no space, no text. It never
  tells anyone whether the page exists.
- **Share links** (`/share/…`) and pages of a **public site** unfurl for
  everyone, connected or not: they follow their own public rules.

## Privacy

**A preview is visible to everyone in the conversation**, whatever their own
rights in Folio. That is how Slack and Teams previews work: the card is built
once, for the person who shared the link, and posted into the channel. So Folio
leaves out what the channel may not be meant to see:

- A page that is **not open to its whole space** (restricted to specific people,
  or a `.agent` page) shows its **title only**: no text, headings, tags or
  columns, and the note "Restricted page".
- The breadcrumb never names a parent page the sharer cannot read, or a
  restricted one: that level shows as `…`.
- Page text goes out as plain text: markup, mentions and links inside a page are
  never interpreted by the chat app.

What Folio stores for a connected person: the chat user id and display name,
the workspace or tenant id, and the OAuth tokens of the connection, encrypted
with `FOLIO_SECRET`. For a Slack message posted before its author connected,
Folio keeps the channel, message timestamp and Folio links for 30 minutes so it
can add the preview later. Message text is never stored.

**Disconnecting.** A person disconnects in **API tokens → Chat apps**. An
instance administrator sees every connection in **Administration → Chat
integrations** and can disconnect any of them. Disabling a Folio user stops
their previews at once. A connection that is not used for 30 days lapses by
itself (its refresh token expires) and the person is asked to connect again.

## Requirements

- `PUBLIC_URL` set to an `https://` address that Slack and Microsoft can reach
  from the internet. Previews and connections are built from it.
- `FOLIO_SECRET` set (it always is with the bundled compose file).
- For Slack: permission to create an app in the workspace and install it.
- For Teams: an Azure subscription to register a bot, and a Microsoft 365
  administrator who uploads the Teams app to the organization's catalog.

An instance administrator finds everything to copy in **Administration → Chat
integrations**: which variables are set (names only, never values), the URLs to
paste, the link domains, the Slack app manifest and the Teams app package, and
how many people connected.

## Slack

One workspace per Folio instance (a single bot token).

1. In Folio, open **Administration → Chat integrations** and click **Download
   Slack app manifest**. It is filled in with your addresses; the example below
   shows its shape.
2. Go to <https://api.slack.com/apps>, **Create New App → From a manifest**,
   choose the workspace and paste the manifest.
3. In the app's **Basic Information**, copy the **Signing Secret**, the
   **Client ID** and the **Client Secret**. Set them as
   `FOLIO_SLACK_SIGNING_SECRET`, `FOLIO_SLACK_CLIENT_ID` and
   `FOLIO_SLACK_CLIENT_SECRET`.
4. **OAuth & Permissions → Install to Workspace**, then copy the **Bot User
   OAuth Token** (`xoxb-…`) into `FOLIO_SLACK_BOT_TOKEN`. Optionally set
   `FOLIO_SLACK_TEAM_ID` (the workspace id, `T…`) so that only members of that
   workspace can connect.
5. Restart Folio. The Chat integrations page now says **Configured**.
6. Back in the Slack app settings, open **Event Subscriptions** and let Slack
   verify the Request URL (with an app created from a manifest it may ask you to
   click **Verify**). It succeeds only once Folio runs with the signing secret.
7. Post a link to a Folio page in a channel to try it.

Example manifest (for `https://folio.example.com`):

```yaml
display_information:
  name: Folio
  description: Previews of Folio links, built with each person's own Folio access.
  background_color: "#1c1917"
features:
  bot_user:
    display_name: folio
    always_online: false
  unfurl_domains:
    - folio.example.com
oauth_config:
  redirect_urls:
    - https://folio.example.com/api/integrations/slack/oidc/callback
  scopes:
    bot:
      - links:read
      - links:write
settings:
  event_subscriptions:
    request_url: https://folio.example.com/api/integrations/slack/events
    bot_events:
      - link_shared
  interactivity:
    is_enabled: true
    request_url: https://folio.example.com/api/integrations/slack/interactions
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

`unfurl_domains` lists your Folio host and, when public sites are set up, the
`PUBLIC_SITES_DOMAIN` and custom site domains (Slack allows five). Changing
domains means reinstalling the app. "Sign in with Slack" uses the same app and
asks for `openid profile` itself; it is how Folio makes sure the person
connecting is the Slack user who shared the link.

| Setting | What it is |
|---|---|
| `FOLIO_SLACK_SIGNING_SECRET` | Basic Information → Signing Secret. Every request from Slack is checked with it. |
| `FOLIO_SLACK_BOT_TOKEN` | OAuth & Permissions → Bot User OAuth Token (`xoxb-…`). |
| `FOLIO_SLACK_CLIENT_ID`, `FOLIO_SLACK_CLIENT_SECRET` | Basic Information → App Credentials. Used for Sign in with Slack. |
| `FOLIO_SLACK_TEAM_ID` | Optional. Only this workspace may connect. |

## Microsoft Teams

Single tenant: one Microsoft Entra tenant per Folio instance.

1. In the Azure portal, **Create a resource → Azure Bot**. Type of App:
   **Single Tenant**; let it create a new Microsoft App ID. The free pricing tier
   is enough.
2. In the bot's **Configuration**, set **Messaging endpoint** to
   `<PUBLIC_URL>/api/integrations/teams/messages`. Copy the **Microsoft App ID**
   and the **App Tenant ID**.
3. In **Channels**, add **Microsoft Teams**.
4. Set `FOLIO_TEAMS_APP_ID` and `FOLIO_TEAMS_TENANT_ID` and restart Folio.
   Previews do not need the app password: Folio answers Teams in the same
   request. You can still create one (**Manage Password**) and keep it as
   `FOLIO_TEAMS_APP_PASSWORD`.
5. In Folio, **Administration → Chat integrations → Download Teams app
   package**. The zip holds `manifest.json` (your bot id, your domains, link
   unfurling with zero install) and the two icons.
6. A Microsoft 365 administrator uploads it: **Teams admin center → Teams apps →
   Manage apps → Upload new app**, and allows it in the app permission policy if
   your organization restricts apps. For a quick test, a user can upload it under
   **Apps → Manage your apps → Upload an app**, if custom app upload is allowed.
7. Paste a link to a Folio page into a Teams message to try it.

| Setting | What it is |
|---|---|
| `FOLIO_TEAMS_APP_ID` | Azure Bot → Configuration → Microsoft App ID. Requests from Teams must be addressed to it. |
| `FOLIO_TEAMS_TENANT_ID` | Azure Bot → Configuration → App Tenant ID. Requests from any other tenant are refused. |
| `FOLIO_TEAMS_APP_PASSWORD` | Optional; not used by previews. |

Every request from Teams carries a token signed by the Bot Framework; Folio
checks its signature against Microsoft's published keys, its issuer, that it is
meant for your bot, that the key is endorsed for Teams and that it names the
same Teams service as the request.

With **zero install** (the package enables it), Teams asks Folio about a link
even for people who have not added the app: share links and public pages get
their card; any other Folio link asks the person to sign in.

## Limits

- **One card for the whole conversation**, built with the access of the person
  who shared the link (see Privacy). Teams can refresh a card for each viewer
  with Universal Actions; Folio does not do that yet.
- **Restricted pages show their title only**, even to people who can open them.
- **A preview is a snapshot.** It shows the page as it was when the link was
  shared and is not updated later.
- **Slack: one workspace**, with the bot token of a single installation.
  Enterprise Grid org-wide installs are not supported. Only messages posted in
  the 30 minutes before someone connects get their preview afterwards.
- **Teams: one tenant.** Connecting needs the desktop or web client: on mobile,
  Teams unfurls only links that need no sign-in (share links, public pages).
  Teams does not cache Folio cards (each paste asks Folio again).
- **Cards are in English**: they are posted into a conversation whose readers'
  languages Folio does not know.
- **Folders** (`/s/<space>/d/…`) show the space's card.
