# Grammarly Docs MCP

Local-first [Model Context Protocol](https://modelcontextprotocol.io/) server for Grammarly Docs automation.

This server lets MCP clients open a logged-in Grammarly Docs session, inspect available Grammarly features, run individual writing tools, and optionally use an LLM rewrite loop against Grammarly AI-detection and plagiarism results.

> [!IMPORTANT]
> This project automates the Grammarly web UI. It is not an official Grammarly product and does not use a private Grammarly API.

## Why This Exists

Most Grammarly automation examples depend on cloud browsers or one-off screen control. This project adds a more practical path:

- Use a **local Chrome profile** for Grammarly login.
- Run normal checks **headlessly in the background**.
- Expose Grammarly features through stable MCP tools.
- Keep browser-service API keys optional, not mandatory.

## Features

| Area | What it does |
| --- | --- |
| Local browser automation | Uses Playwright with a persistent Chrome profile. |
| Login helper | Opens a visible browser only when you need to log in or repair a session. |
| Feature inventory | Reports which Grammarly Docs tools are visible for the current account. |
| Proofreading | Reads visible writing quality and Proofreader panel output. |
| AI detection | Opens Grammarly AI Detector and extracts visible AI percentage when available. |
| Plagiarism | Opens Grammarly Plagiarism Checker and extracts visible plagiarism/originality results. |
| Metrics | Returns words, characters, sentences, paragraphs, and visible Grammarly word count. |
| Agents | Opens supported Grammarly Docs agents such as Paraphraser, Humanizer, AI Rewriter, Reader Reactions, AI Grader, and Authorship. |
| Optimization | Optional rewrite/analyze loop using the configured LLM provider. |

## Supported MCP Tools

| Tool | Purpose |
| --- | --- |
| `grammarly_open_login_browser` | Opens the local persistent browser profile so you can log into Grammarly. |
| `grammarly_list_features` | Lists Grammarly features and whether the logged-in Docs UI exposes them. |
| `grammarly_run_feature` | Runs one Grammarly feature against supplied text. |
| `grammarly_optimize_text` | Scores, analyzes, or rewrites text against AI/plagiarism thresholds. |

## Grammarly Feature IDs

`grammarly_run_feature` accepts these `feature` values:

```text
proofreader
grammar-checker
spell-checker
punctuation-checker
tone-detector
word-counter
character-counter
paragraph-counter
sentence-counter
sentence-checker
passive-voice-checker
essay-checker
ai-writing-tools
ai-chat
paraphraser
paraphrasing-tool
reader-reactions
humanizer
ai-humanizer
citation
citation-generator
citation-finder
ai-detector
ai-rewriter
plagiarism-checker
ai-grader
authorship
resume-builder
style-guide
snippets
analytics
brand-tones
```

Some IDs are public Grammarly product surfaces that may not appear in every Grammarly Docs account. When a feature is not visible locally, the server returns `available: false` instead of pretending it ran.

Rewrite-producing tools such as Humanizer, Paraphraser, and AI Rewriter apply Grammarly's visible rewrite suggestion when an `Accept` control is available. The server rejects accepted text that does not appear related to the current input, then returns the editor state in `documentText`.

## Requirements

- Node.js 18 or newer
- pnpm
- Google Chrome or a compatible Chromium browser
- A Grammarly account
- An MCP client such as Claude Desktop or Claude Code

Optional:

- Claude Code CLI for rewrite/analyze modes using local Claude authentication
- Browserbase credentials for Stagehand cloud mode
- Browser Use Cloud credentials for legacy cloud mode

## Installation

```bash
git clone https://github.com/michaelheichler/grammarly-docs-mcp.git
cd grammarly-docs-mcp
pnpm install
pnpm build
```

## Recommended Configuration

Use local Chrome first. It keeps Grammarly auth on your machine and avoids browser-service API keys.

```bash
BROWSER_PROVIDER=local-playwright
LOCAL_BROWSER_CHANNEL=chrome
LOCAL_BROWSER_HEADLESS=true
LOCAL_BROWSER_PROFILE_DIR=~/.grammarly-mcp/chrome-profile
LOCAL_BROWSER_SESSION_MODE=isolated-copy
REWRITE_LLM_PROVIDER=claude-code
CLAUDE_MODEL=auto
LOG_LEVEL=info
```

Copy `.env.example` if you want a local env file:

```bash
cp .env.example .env
```

> [!WARNING]
> Do not commit `.env`. It can contain browser-service credentials or model-provider API keys.

## MCP Client Setup

### Claude Code

```bash
claude mcp add grammarly-docs -- node "$(pwd)/dist/server.js"
```

### Claude Desktop

Add this server entry to your Claude Desktop MCP configuration:

```json
{
  "mcpServers": {
    "grammarly-docs": {
      "command": "node",
      "args": ["/absolute/path/to/grammarly-docs-mcp/dist/server.js"],
      "env": {
        "BROWSER_PROVIDER": "local-playwright",
        "LOCAL_BROWSER_CHANNEL": "chrome",
        "LOCAL_BROWSER_HEADLESS": "true",
        "LOCAL_BROWSER_PROFILE_DIR": "/Users/you/.grammarly-mcp/chrome-profile",
        "LOCAL_BROWSER_SESSION_MODE": "isolated-copy",
        "REWRITE_LLM_PROVIDER": "claude-code",
        "CLAUDE_MODEL": "auto"
      }
    }
  }
}
```

## First Run

1. Build the server.

   ```bash
   pnpm build
   ```

2. Run `grammarly_open_login_browser` from your MCP client.

3. Log into Grammarly in the browser window that opens.

4. Close or let the login tool finish.

5. Use `grammarly_list_features` to verify the session.

After login, normal calls can run in headless Chrome without putting a browser window in front of you.

By default, each normal local call clones the logged-in base profile into an isolated temporary profile. That allows simultaneous MCP calls to run in separate browser instances without Chromium profile-lock conflicts.

## Usage Examples

### List Available Grammarly Tools

```json
{
  "tool": "grammarly_list_features",
  "arguments": {}
}
```

### Run AI Detection

```json
{
  "tool": "grammarly_run_feature",
  "arguments": {
    "feature": "ai-detector",
    "text": "Paste the text you want Grammarly to inspect here."
  }
}
```

### Run Plagiarism Check

```json
{
  "tool": "grammarly_run_feature",
  "arguments": {
    "feature": "plagiarism-checker",
    "text": "Paste the text you want checked for overlap."
  }
}
```

### Ask the Paraphraser Agent

```json
{
  "tool": "grammarly_run_feature",
  "arguments": {
    "feature": "paraphraser",
    "text": "This sentence is functional, but it could be tighter.",
    "instruction": "Make this more concise and natural."
  }
}
```

### Score Without Rewriting

```json
{
  "tool": "grammarly_optimize_text",
  "arguments": {
    "mode": "score_only",
    "text": "Paste a longer text sample here.",
    "response_format": "json"
  }
}
```

### Analyze and Rewrite

```json
{
  "tool": "grammarly_optimize_text",
  "arguments": {
    "mode": "optimize",
    "text": "Paste a longer text sample here.",
    "max_ai_percent": 10,
    "max_plagiarism_percent": 5,
    "max_iterations": 3,
    "tone": "neutral"
  }
}
```

## Output Shape

`grammarly_run_feature` returns structured data:

```json
{
  "feature": "ai-detector",
  "available": true,
  "loggedIn": true,
  "finalUrl": "https://coda.grammarly.com/...",
  "panelText": "Visible Grammarly panel text...",
  "documentText": "Text visible in the editor...",
  "scores": {
    "writingQuality": null,
    "aiDetectionPercent": 48,
    "plagiarismPercent": null
  },
  "metrics": {
    "words": 121,
    "characters": 700,
    "charactersNoSpaces": 580,
    "sentences": 6,
    "paragraphs": 1,
    "grammarlyWordCount": 121
  },
  "notes": "Opened the requested Grammarly feature..."
}
```

## Browser Providers

| Provider | Value | Best for |
| --- | --- | --- |
| Local Playwright | `local-playwright` | On-device use, no browser-service API keys. |
| Stagehand + Browserbase | `stagehand` | Cloud browser workflows. |
| Browser Use Cloud | `browser-use` | Legacy Browser Use setups. |

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `BROWSER_PROVIDER` | `stagehand` | `local-playwright`, `stagehand`, or `browser-use`. |
| `LOCAL_BROWSER_PROFILE_DIR` | `~/.grammarly-mcp/chrome-profile` | Persistent local browser profile. |
| `LOCAL_BROWSER_HEADLESS` | `false` | Runs normal local calls headlessly when `true`. |
| `LOCAL_BROWSER_CHANNEL` | unset | Browser channel such as `chrome`. |
| `LOCAL_BROWSER_EXECUTABLE` | unset | Explicit browser executable path. |
| `LOCAL_BROWSER_SESSION_MODE` | `isolated-copy` | `isolated-copy` clones the login profile per call for parallel browser sessions; `shared-profile` uses the base profile directly. |
| `LOCAL_BROWSER_SESSION_PROFILE_ROOT` | `~/.grammarly-mcp/session-profiles` | Temporary profile root for isolated local sessions. |
| `LOCAL_BROWSER_KEEP_SESSION_PROFILES` | `false` | Keeps isolated session profile copies after browser close for debugging. |
| `REWRITE_LLM_PROVIDER` | auto | `claude-code`, `openai`, `google`, or `anthropic`. |
| `CLAUDE_MODEL` | `auto` | `auto`, `haiku`, `sonnet`, or `opus`. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. |

Cloud provider variables are documented in `.env.example`.

## Development

```bash
pnpm install
pnpm build
pnpm type-check
pnpm biome:check
pnpm test:run
```

## Troubleshooting

### The server says Grammarly is not logged in

Run `grammarly_open_login_browser`, complete login, then retry.

### A feature returns `available: false`

The feature is not visible in the current Grammarly Docs UI for the logged-in account. Some Grammarly product surfaces are plan-specific, account-specific, or not exposed inside Docs.

### Scores are `null`

Grammarly did not show that score in the visible panel. AI Detector and Plagiarism Checker may also require enough text to run.

### A browser window appears

Normal local calls should be headless when `LOCAL_BROWSER_HEADLESS=true`. The login tool intentionally opens a visible browser.

### Parallel local calls fail with a profile-lock error

Use the default `LOCAL_BROWSER_SESSION_MODE=isolated-copy`. `shared-profile` can only support one Chromium process at a time because Chrome locks the user-data directory.

## Security Notes

- The login tool reads and writes inside the persistent base browser profile.
- Normal local calls copy the base profile into temporary isolated profiles by default.
- Do not share the base profile directory.
- Do not commit `.env`.
- Treat Grammarly document contents as sensitive.
- This project does not store Grammarly credentials in the repository.

## Limitations

- UI automation can break when Grammarly changes its Docs interface.
- This is not an official Grammarly API.
- Feature availability depends on your Grammarly account and plan.
- Some agent outputs are visible panel text rather than clean API responses.

## License

This project is licensed under the terms in [LICENSE](LICENSE).
