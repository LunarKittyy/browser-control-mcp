# Browser Control MCP

[![CI](https://github.com/LunarKittyy/browser-control-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/LunarKittyy/browser-control-mcp/actions/workflows/ci.yml)

An MCP server paired with a Firefox extension that lets an AI agent cowork in your browser while you use it: it can keep an eye on what you have open, sort and group your research, archive it into bookmarks, follow up on leads in background tabs, and interact with the sites you allow. What it may touch is decided by an access policy you write, and a pause switch stops it instantly.

This is a fork of [eyalzh/browser-control-mcp](https://github.com/eyalzh/browser-control-mcp). Version 2 changes the protocol between the server and the extension, so both need to come from this repository and be the same version.

## Features

**Tabs and windows**: list tabs by window and group (with duplicates and "opened by agent" marked), open tabs in the background, close, navigate/back/forward/reload, pin, mute, unload, move between windows, reorder.

**Tab groups**: create, add to, rename, recolour, collapse, move, ungroup and dissolve groups, or apply a whole arrangement in one `organize-tabs` call.

**Activity feed**: `get-browser-activity` returns what happened since the agent's last check (tabs opened, closed, navigated, focused, grouped, group changes), marked as done by you or by the agent. Made for periodic check-ins.

**Pages**: read the main content or the full page with metadata (author, publish date, canonical URL) and links, read what you have selected, find & highlight, screenshots.

**Page interaction**: list a page's controls, click, fill in fields and selects, scroll, press keys. Password fields are never read or filled.

**Bookmarks**: search, list, create, edit, remove, and `bookmark-tab-group` to archive a finished group into a folder.

**History**: search with a time window.

**Agent workspace**: tabs the agent opens go into a background "Agent" tab group (or a separate window) so they don't pull you away from what you're doing.

**Toolbar popup**: connection status, a pause switch (also `Alt+Shift+P`), approvals for pending requests, recent activity.

## Access policy

The extension's settings page holds a small policy language. One rule per line:

```
<allow | ask | deny | hide> <what> on <where>
```

Rules are read top to bottom and **later rules override earlier ones**, so general rules go first and exceptions after. `hide` is the exception: a matching `hide` rule always wins and makes the target invisible to the agent. Hidden tabs don't show up in tab lists, history, the activity feed or group listings, and asking for one by ID gets the same answer as a tab that doesn't exist. Anything no rule allows is denied.

```
# Read and organise freely, ask before screenshots or touching pages
allow see, manage, navigate, read, selection on *
ask   screenshot, interact on *

# Let it shop on IKEA on its own
allow interact, screenshot on site:ikea.com

# Things it should never even know about
hide on site:swedbank.se
hide on group:"Private*"
hide on container:"Banking"
hide on private

# Bookmarks: read everything, write only in its own folder
allow bookmarks.read on *
allow bookmarks.write on folder:"Agent/**"
```

| What | Allows the agent to |
| --- | --- |
| `see` | see the tab/site in tab lists, history and the activity feed |
| `read` | read page text, links and metadata, find & highlight |
| `selection` | read what you have selected |
| `screenshot` | capture screenshots |
| `manage` | close, move, group, pin, mute and unload tabs |
| `navigate` | open or load URLs |
| `interact` | click, type and scroll in pages |
| `bookmarks.read`, `bookmarks.write` | read / change bookmarks (`bookmarks` means both) |
| `all` | everything |

| Where | Matches |
| --- | --- |
| `*` | everything |
| `site:ikea.com` | ikea.com and its subdomains (`site:*.ikea.com`: subdomains only) |
| `url:https://github.com/me/*` | full URLs, `*` matches anything |
| `group:"Research*"` | tabs in tab groups whose title matches |
| `container:"Banking"` | tabs in a Firefox container |
| `private` | private windows |
| `agent` | tabs the agent opened |
| `folder:"Agent/**"` | bookmark folders. `*` stays within one folder, `**` spans any depth. Paths start at `toolbar`, `menu`, `other` or `mobile`; a leading `/` anchors the pattern there, otherwise it matches from any folder down |

Put `!` in front of a selector to negate it, and list several selectors on one line when all of them must match (`allow interact on site:github.com group:"Research*"`).

`ask` works for `read`, `selection`, `screenshot` and `interact`. The agent gets told to wait, the toolbar button shows `!` on that tab, and the popup offers **Allow once** (until the tab navigates), **Always on this site** (adds an `allow` rule for you) or **Deny**.

The settings page has presets (Strict, Balanced, Autonomous), live error checking, and a "Try it" box that shows what the agent could do with a given URL, group, container or bookmark folder. The agent can call `get-browser-status` to read the policy in plain words, so it doesn't have to find the limits by trial and error.

The policy sits on top of Firefox's own permissions: the extension still needs access to a site before it can script it. Grant "Access to all sites" in the settings to let the policy alone decide, or approve sites as they come up. Opening the toolbar popup on a tab also gives access to that tab until it navigates.

## Example use-cases

- *"Every half hour, look at what I've opened since your last check, group it by topic, and close duplicates."*
- *"The tabs in my 'GPU research' group: read them, find the three most promising leads, and open follow-up sources in the background."*
- *"Archive the 'Trip planning' group into bookmarks and close it."*
- *"What does the paragraph I just highlighted mean, and is the claim backed up anywhere else?"*
- *"Find a white KALLAX shelf on IKEA and put it in the cart."* (with `interact` allowed on ikea.com)

## Security model

- The server only listens on loopback, and every message in both directions is signed with a shared secret. A connection only counts once it has sent a correctly signed hello, so another local program can't take over the socket.
- The access policy is enforced in the extension, not the server, so a misbehaving agent or server can't bypass it.
- Hidden targets are indistinguishable from nonexistent ones.
- Password fields are never read or typed into, and card-number fields are never read.
- The pause switch rejects every command except the status check.
- The extension keeps an audit log of every command with its outcome, and has no runtime third-party dependencies.
- Page content is untrusted: the server's instructions tell the agent not to follow instructions found in pages. Allowing `interact` on a site still means the agent can do on that site whatever you could, so keep it to sites where that's fine.

**Note**: this is experimental software. Watch what the agent does, especially with `interact` allowed.

## Installation

Version 2 is not on addons.mozilla.org; the add-on there is the upstream 1.x version, which can't talk to this server.

### Build from code

```
npm install
npm run build
```

Each CI run also uploads the packaged extension (`.zip`, rename to `.xpi` if you like) and the Claude Desktop `.dxt` as build artifacts.

#### Load the extension in Firefox (139 or later)

1. Open `about:debugging`, click "This Firefox", then "Load Temporary Add-on..."
2. Pick `firefox-extension/manifest.json`
3. The settings page opens. Copy the secret key for the MCP server configuration below.

Temporary add-ons are removed when Firefox restarts. To keep it installed, sign it as an unlisted add-on with `web-ext sign` (needs a free addons.mozilla.org API key), or use Firefox Developer Edition/Nightly with `xpinstall.signatures.required` set to `false` and install the `.xpi`.

#### MCP Server configuration

After installing the browser extension, add the following configuration to your mcpServers configuration (e.g. `claude_desktop_config.json` for Claude Desktop):
```json
{
    "mcpServers": {
        "browser-control": {
            "command": "node",
            "args": [
                "/path/to/repo/mcp-server/dist/server.js"
            ],
            "env": {
                "EXTENSION_SECRET": "<secret_on_firefox_extension_options_page>",
                "EXTENSION_PORT": "8089" 
            }
        }
    }
}
```
Replace `/path/to/repo` with the correct path.

Set the EXTENSION_SECRET to the value shown on the extension's preferences page in Firefox (you can access it at `about:addons`). You can also set the EXTENSION_PORT environment variable to specify the port that the MCP server will use to communicate with the extension (default is 8089).

It might take a few seconds for the MCP server to connect to the extension.

##### Configure the MCP server with Docker

Alternatively, you can use a Docker-based configuration. To do so, build the mcp-server Docker image:
```
docker build -t browser-control-mcp .
```

and use the following mcpServers configuration:

```json
{
    "mcpServers": {
        "browser-control": {
            "command": "docker",
            "args": [
                "run",
                "--rm",
                "-i",
                "-p", "127.0.0.1:8089:8089",
                "-e", "EXTENSION_SECRET=<secret_from_extension>",
                "-e", "CONTAINERIZED=true",
                "browser-control-mcp"
            ]
        }
    }
}
```


## Development

```
npm install          # installs all three packages
npm run typecheck
npm test             # MCP server and extension test suites
npm run build
npm run lint --prefix firefox-extension      # web-ext lint
npm run package --prefix firefox-extension   # build the add-on package
```

CI runs all of the above on every push and pull request, plus a check that every version number in the repo agrees.
