# Metaculus MCP Server

A **remote [MCP](https://modelcontextprotocol.io) server for the [Metaculus](https://www.metaculus.com) forecasting platform**, running on Cloudflare Workers (free tier, stateless, zero server-side secrets). It wraps the official Metaculus API v2 so any MCP-capable agent (Claude, etc.) can browse forecasting questions, submit/withdraw forecasts — including continuous questions via an automatic percentile-sketch → 201-point-CDF builder — post rationale comments, and pull its own score/forecast CSV exports.

**Every user supplies their own free Metaculus API token via a request header.** The Worker holds no credentials and forwards the token only to `https://www.metaculus.com`.

Why this exists: Metaculus runs bot-only AI Forecasting Benchmark tournaments (metaculus.com/aib/) and publishes its own bot-template repos, yet as of 2026-07-12 there was **no Metaculus MCP server anywhere** — 0 hits in registry.modelcontextprotocol.io, 0 among 127 Metaculus-related GitHub repos — while adjacent platforms (Polymarket, Kalshi) have 10+/6+ servers each. This fills that hole.

---

## Tools

| Tool | What it does | API endpoint |
|---|---|---|
| `list_questions` | Browse/filter the question feed: status, type (binary/numeric/date/discrete/multiple-choice/conditional/group), tournament and category slugs, time windows, ordering (e.g. `-hotness`). Returns compact summaries. | `GET /api/posts/` |
| `get_question` | Full detail for one post: description, resolution criteria, fine print, subquestions, and the `question.scaling` data needed to build continuous forecasts. | `GET /api/posts/{postId}/` |
| `get_my_predictions` | Posts a given user (you) has forecast on — your active book / track record surface. | `GET /api/posts/?forecaster_id=…` |
| `submit_forecast` | Submit one or many forecasts: `probability_yes` (binary), `probability_yes_per_category` (multiple-choice), a full `continuous_cdf`, **or a `percentiles` sketch that the server converts into a spec-valid CDF** (linear & log scaling, open/closed bounds, minimum-slope rules handled per the spec's documented algorithm). | `POST /api/questions/forecast/` |
| `withdraw_forecast` | Withdraw current forecasts on one or many questions. | `POST /api/questions/withdraw/` |
| `post_comment` | Publish a (public or private) comment, e.g. a bot's forecast rationale; supports replies and attaching your latest forecast. | `POST /api/comments/create/` |
| `get_comments` | Read comments, filtered per the API's access rule (`author=<your id>` and/or `author_is_staff=true`). | `GET /api/comments/` |
| `download_question_data` | Fetch the CSV Zip export (question/forecast/score data), unzip it in the Worker, and return parsed rows. **Restricted endpoint** — see caveats. | `GET /api/data/download/` |

The MCP handshake and `tools/list` work **without** a token (so registries can scan the server); every tool call requires one and returns setup instructions if it's missing.

## Authentication

1. Create a free Metaculus account, then generate an API token at **https://www.metaculus.com/accounts/settings/account/#api-access** (URL from the official API spec).
2. Configure your MCP client to send the token on every request. Accepted headers (first match wins):
   - `Authorization: Token <token>` — Metaculus's native scheme
   - `Authorization: Bearer <token>`
   - `X-Metaculus-Token: <token>`

The entire Metaculus API rejects unauthenticated requests (verified live 2026-07-12: `GET https://www.metaculus.com/api/posts/?limit=1` without a token → HTTP 403 *"The API is only available to authenticated users."*).

### Connect from Claude Code

```bash
claude mcp add --transport http metaculus \
  https://metaculus-mcp.anishboddu6.workers.dev/mcp \
  --header "Authorization: Token YOUR_METACULUS_TOKEN"
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "metaculus": {
      "type": "http",
      "url": "https://metaculus-mcp.anishboddu6.workers.dev/mcp",
      "headers": { "Authorization": "Token ${METACULUS_TOKEN}" }
    }
  }
}
```

(Syntax verified against the Claude Code MCP docs, code.claude.com/docs/en/mcp, accessed 2026-07-12.)

## Deploy

```bash
npm install
npm run typecheck        # tsc --noEmit
npm run build            # wrangler deploy --dry-run --outdir=dist
npx wrangler deploy      # needs a wrangler-authenticated machine
```

No bindings, no secrets, no Durable Objects — a single stateless Worker. `observability.enabled = true` gives you usage logs in the Cloudflare dashboard (tool calls log only method + whether a token was present, **never** token values).

## Test locally

```bash
npx wrangler dev --port 8799
```

```bash
# 1) MCP handshake
curl -s -X POST http://localhost:8799/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'

# 2) List the 8 tools
curl -s -X POST http://localhost:8799/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 3) Real call (uses YOUR token against the live API)
curl -s -X POST http://localhost:8799/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Token YOUR_METACULUS_TOKEN" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_questions","arguments":{"statuses":["open"],"limit":3,"order_by":"-hotness"}}}'
```

## Honest caveats (all from the official API spec, accessed 2026-07-12)

- **Terms of Use govern the data.** Per the spec's own warning: API data **may not be used to train, evaluate, or otherwise create or develop AI/ML models** without Metaculus's prior written permission, and **any commercial use requires a separate written agreement** (https://www.metaculus.com/terms-of-use/). Using questions as live LLM context to *forecast* is exactly what Metaculus's own bot tournaments invite — but do not resell or train on the data.
- **Community Prediction is tier-limited.** Normal authenticated accounts see CP aggregates on only ~50 questions. A free "Bot Benchmarking Access Tier" (requested via the Metaculus Data Needs Google Form linked at metaculus.com/api/) extends CP/resolution access to ~250 open + ~250 resolved questions. Your own predictions/scores/comments are always available to you.
- **`download_question_data` (and the email variant) are restricted endpoints** — the spec directs users to the same Data Needs Form for access, and `project_id` exports additionally need per-project whitelisting. Expect 4xx errors without that grant.
- **Rate limits: UNKNOWN.** The spec states request throttling applies to metaculus.com but publishes no numbers. The server surfaces 429s verbatim with a back-off hint.
- **No free-text search.** The documented `GET /api/posts/` has structured filters only; there is no documented search parameter.
- **Comments access rule.** When API access is restricted, `GET /api/comments/` requests must filter by `author=<your own user id>` and/or `author_is_staff=true`.

## Publishing to registries

Current state: this server has **not** been submitted anywhere yet. All three processes below were verified 2026-07-12; each requires human steps (accounts/logins).

1. **Official MCP Registry (registry.modelcontextprotocol.io)** — publish `server.json` (template included in this repo; fill in your GitHub username + workers.dev URL) with the `mcp-publisher` CLI. GitHub-based authentication requires the server name to start with `io.github.<your-username>/`. Remote-only servers need no npm package — the `remotes` entry with your public Workers URL is enough, and the included `headers` entry (`isRequired`/`isSecret`) tells clients to collect the user's token. Source: modelcontextprotocol/registry repo docs (`quickstart.mdx`, `remote-servers.mdx`).
2. **mcp.so** — submissions "only support public GitHub MCP servers": push this directory to a **public GitHub repo**, sign in at mcp.so, submit the repo URL at https://mcp.so/submit, then complete the draft (saving publishes it). Source: the mcp.so submit page, fetched 2026-07-12.
3. **Smithery (smithery.ai)** — go to https://smithery.ai/new, enter the server's public HTTPS URL, and complete the publishing flow (requirement: Streamable HTTP transport — this server complies). Smithery scans the server to extract tool metadata; because this server answers `initialize`/`tools/list` without a token, the automatic scan can complete. Source: smithery.ai/docs/build/publish.md, fetched 2026-07-12.

So the one **hard human prerequisite** across registries: a public GitHub repo (required by mcp.so; also the natural namespace proof for the official registry) and the respective account logins.

## Monetization (honest note)

MCP has no native billing layer. **v1 is free and usage-logged** (Cloudflare observability shows request counts and authed/unauthed split). If usage materializes, later options include a hosted "pro" tier (e.g. caching, scheduled scans, portfolio alerts) — but note the Metaculus ToS clause above: **any commercial use of Metaculus API data itself requires a written agreement with Metaculus**, so monetize the tooling/infrastructure only after securing that, or keep it free as a distribution/reputation asset.

## Architecture

- `src/index.ts` — Worker entry: token extraction from headers, `/` info page, `/mcp` endpoint via `createMcpHandler` (Cloudflare Agents SDK, Streamable HTTP transport). A fresh `McpServer` per request (MCP SDK ≥ 1.26.0 requirement for stateless servers).
- `src/server.ts` — the 8 tool registrations (zod schemas + response slimming to keep agent context small).
- `src/metaculus.ts` — thin authenticated fetch client for `https://www.metaculus.com/api`.
- `src/cdf.ts` — TypeScript port of the CDF algorithms documented in the official API spec: nominal→scaled location (linear + logarithmic `zero_point` scaling), percentile-sketch interpolation, the spec's bound/slope standardization step, and validation of all documented CDF rules (16 unit checks pass, including the spec's own scaling examples).
- Stack: `agents` 0.17.3, `@modelcontextprotocol/sdk` 1.29.0, `zod` 4, `fflate` (CSV-zip parsing), TypeScript 5 strict, wrangler v4.

## Sources (all accessed 2026-07-12)

- Official Metaculus OpenAPI 3.0.0 spec (version 2.0.0): https://raw.githubusercontent.com/Metaculus/metaculus/main/docs/openapi.yml (rendered at https://www.metaculus.com/api/) — endpoints, parameters, payload schemas, TokenAuth scheme, access tiers, ToS restrictions, CDF algorithm and rules, restricted-endpoint notes.
- Live auth behavior: `GET https://www.metaculus.com/api/posts/?limit=1` → HTTP 403 (unauthenticated).
- Cloudflare Agents SDK MCP docs: https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/ (createMcpHandler, stateless pattern, SDK 1.26.0 breaking change) and .../apis/agent-api/.
- MCP Registry publishing: https://github.com/modelcontextprotocol/registry — docs/modelcontextprotocol-io/quickstart.mdx and remote-servers.mdx.
- mcp.so submission requirements: https://mcp.so/submit.
- Smithery publishing: https://smithery.ai/docs/build/publish.md.
- Claude Code client config syntax: https://code.claude.com/docs/en/mcp.md.
