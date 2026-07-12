/**
 * Metaculus MCP server — Cloudflare Worker entry point.
 *
 * Stateless remote MCP server (Streamable HTTP transport) using createMcpHandler
 * from the Cloudflare Agents SDK. A fresh McpServer is created per request
 * (required by MCP SDK >= 1.26.0), with the caller's Metaculus API token captured
 * from a request header. The Worker stores NO secrets and has NO bindings.
 *
 * Token headers accepted (first match wins):
 *   X-Metaculus-Token: <token>
 *   Authorization: Token <token>     (Metaculus's native scheme)
 *   Authorization: Bearer <token>
 *
 * The MCP handshake and tools/list work WITHOUT a token, so clients and registry
 * scanners can discover tools; each tool call returns setup instructions if the
 * token is missing.
 */

import { createMcpHandler } from "agents/mcp";
import { createMetaculusServer } from "./server";

export interface Env {}

function extractToken(request: Request): string | null {
  const custom = request.headers.get("x-metaculus-token");
  if (custom && custom.trim()) return custom.trim();
  const auth = request.headers.get("authorization");
  if (auth) {
    const match = auth.match(/^\s*(?:Token|Bearer)\s+(\S+)\s*$/i);
    if (match && match[1]) return match[1];
  }
  return null;
}

const INFO = {
  name: "metaculus-mcp",
  description:
    "Remote MCP server for the Metaculus forecasting platform API v2. " +
    "Connect your MCP client to POST /mcp (Streamable HTTP transport).",
  mcp_endpoint: "/mcp",
  authentication:
    "Per-user Metaculus API token, sent by YOUR client on every request via one of: " +
    "'Authorization: Token <token>', 'Authorization: Bearer <token>', or " +
    "'X-Metaculus-Token: <token>'. Generate a free token at " +
    "https://www.metaculus.com/accounts/settings/account/#api-access . " +
    "This server stores no credentials; your token is forwarded only to https://www.metaculus.com.",
  tools: [
    "list_questions",
    "get_question",
    "get_my_predictions",
    "submit_forecast",
    "withdraw_forecast",
    "post_comment",
    "get_comments",
    "download_question_data",
  ],
  terms:
    "All data retrieved is governed by the Metaculus Terms of Use " +
    "(https://www.metaculus.com/terms-of-use/): no training/evaluating/developing AI-ML models " +
    "on API data without written permission, and no commercial use without a separate written agreement.",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(JSON.stringify(INFO, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/mcp") {
      const token = extractToken(request);
      // Usage logging (visible in Workers observability). NEVER log token values.
      console.log(
        JSON.stringify({
          evt: "mcp_request",
          method: request.method,
          authed: token !== null,
        }),
      );
      const server = createMetaculusServer(token);
      return createMcpHandler(server, {
        route: "/mcp",
        corsOptions: {
          origin: "*",
          methods: "GET, POST, DELETE, OPTIONS",
          headers: "Content-Type, Authorization, X-Metaculus-Token, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
          exposeHeaders: "Mcp-Session-Id",
        },
      })(request, env, ctx);
    }

    return new Response("Not found. MCP endpoint is at /mcp; server info at /.", {
      status: 404,
    });
  },
} satisfies ExportedHandler<Env>;
