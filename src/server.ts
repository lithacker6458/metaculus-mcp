/**
 * Metaculus MCP server — tool definitions.
 *
 * A new McpServer instance is created per request (required by MCP SDK >= 1.26.0
 * for stateless servers), with the caller's own Metaculus API token captured in a
 * closure. The Worker holds no secrets.
 *
 * All endpoint paths, parameters, and payload shapes come from the official
 * Metaculus OpenAPI 3.0.0 spec (version 2.0.0), docs/openapi.yml in the
 * Metaculus/metaculus repo / https://www.metaculus.com/api/ (accessed 2026-07-12).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { unzipSync, strFromU8 } from "fflate";
import {
  METACULUS_BASE,
  MetaculusApiError,
  NO_TOKEN_MESSAGE,
  metFetch,
  metJson,
} from "./metaculus";
import { buildCdfFromPercentiles, validateCdf, type QuestionForCdf } from "./cdf";

const MAX_TEXT_LENGTH = 180_000;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function textResult(text: string, isError = false): ToolResult {
  const clipped =
    text.length > MAX_TEXT_LENGTH
      ? text.slice(0, MAX_TEXT_LENGTH) +
        `\n\n[Output truncated at ${MAX_TEXT_LENGTH} characters. Narrow your query (e.g. lower "limit") to see everything.]`
      : text;
  return isError
    ? { content: [{ type: "text", text: clipped }], isError: true }
    : { content: [{ type: "text", text: clipped }] };
}

function jsonResult(value: unknown): ToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

function errorResult(err: unknown): ToolResult {
  if (err instanceof MetaculusApiError) {
    return textResult(
      `Metaculus API returned HTTP ${err.status} for ${err.url}\n${err.body}`,
      true,
    );
  }
  return textResult(err instanceof Error ? err.message : String(err), true);
}

/* ------------------------------------------------------------------ */
/* Response slimming (keeps agent context small; raw=true bypasses)    */
/* ------------------------------------------------------------------ */

type AnyObj = Record<string, unknown>;

function slimQuestion(q: unknown): AnyObj | undefined {
  if (!q || typeof q !== "object") return undefined;
  const question = q as AnyObj;
  const scaling = question.scaling as AnyObj | undefined;
  const out: AnyObj = {
    id: question.id,
    title: question.title,
    type: question.type,
    status: question.status,
    resolution: question.resolution,
    unit: question.unit,
    options: question.options,
    open_time: question.open_time,
    scheduled_close_time: question.scheduled_close_time,
    scheduled_resolve_time: question.scheduled_resolve_time,
    open_lower_bound: question.open_lower_bound,
    open_upper_bound: question.open_upper_bound,
    inbound_outcome_count: question.inbound_outcome_count,
  };
  if (scaling) {
    out.scaling = {
      range_min: scaling.range_min,
      range_max: scaling.range_max,
      zero_point: scaling.zero_point,
    };
  }
  // Present only when requested via include_descriptions / with_cp.
  for (const key of ["description", "resolution_criteria", "fine_print", "aggregations", "my_forecasts"]) {
    if (question[key] !== undefined && question[key] !== "" && question[key] !== null) {
      out[key] = question[key];
    }
  }
  for (const key of Object.keys(out)) {
    if (out[key] === undefined || out[key] === null) delete out[key];
  }
  return out;
}

function slimPost(p: unknown): AnyObj {
  const post = p as AnyObj;
  const out: AnyObj = {
    post_id: post.id,
    title: post.title,
    url: `${METACULUS_BASE}/questions/${post.id}/`,
    author_username: post.author_username,
    status: post.status,
    resolved: post.resolved,
    open_time: post.open_time,
    scheduled_close_time: post.scheduled_close_time,
    scheduled_resolve_time: post.scheduled_resolve_time,
    nr_forecasters: post.nr_forecasters,
    comment_count: post.comment_count,
  };
  if (post.question) out.question = slimQuestion(post.question);
  const group = post.group_of_questions as AnyObj | undefined;
  if (group && Array.isArray(group.questions)) {
    out.group_of_questions = { questions: group.questions.map(slimQuestion) };
  }
  const conditional = post.conditional as AnyObj | undefined;
  if (conditional) {
    out.conditional = {
      question_yes: slimQuestion(conditional.question_yes),
      question_no: slimQuestion(conditional.question_no),
    };
  }
  if (post.notebook) out.is_notebook = true;
  for (const key of Object.keys(out)) {
    if (out[key] === undefined || out[key] === null) delete out[key];
  }
  return out;
}

/** Locate a question object (by question id) inside a post detail payload. */
function findQuestionInPost(post: AnyObj, questionId: number): QuestionForCdf | undefined {
  const candidates: unknown[] = [post.question];
  const group = post.group_of_questions as AnyObj | undefined;
  if (group && Array.isArray(group.questions)) candidates.push(...group.questions);
  const conditional = post.conditional as AnyObj | undefined;
  if (conditional) candidates.push(conditional.question_yes, conditional.question_no);
  for (const c of candidates) {
    if (c && typeof c === "object" && (c as AnyObj).id === questionId) {
      return c as QuestionForCdf;
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Minimal CSV parsing for the data-download tool                      */
/* ------------------------------------------------------------------ */

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Zod schemas shared across tools                                     */
/* ------------------------------------------------------------------ */

const statusesEnum = z.enum(["upcoming", "open", "closed", "resolved"]);
const forecastTypeEnum = z.enum([
  "binary",
  "multiple_choice",
  "numeric",
  "discrete",
  "date",
  "conditional",
  "group_of_questions",
  "notebook",
]);
const orderByEnum = z.enum([
  "published_at", "-published_at",
  "open_time", "-open_time",
  "vote_score", "-vote_score",
  "comment_count", "-comment_count",
  "forecasts_count", "-forecasts_count",
  "scheduled_close_time", "-scheduled_close_time",
  "scheduled_resolve_time", "-scheduled_resolve_time",
  "user_last_forecasts_date", "-user_last_forecasts_date",
  "unread_comment_count", "-unread_comment_count",
  "weekly_movement", "-weekly_movement",
  "divergence", "-divergence",
  "hotness", "-hotness",
  "score", "-score",
]);

const forecastItemSchema = z.object({
  question: z
    .number()
    .int()
    .describe(
      "The QUESTION id to forecast on (NOT the post id — for simple posts they usually match, " +
        "but for group/conditional posts each subquestion has its own id; get it from get_question).",
    ),
  probability_yes: z
    .number()
    .gt(0)
    .lt(1)
    .optional()
    .describe("For BINARY questions: probability of Yes, strictly between 0 and 1 (e.g. 0.63)."),
  probability_yes_per_category: z
    .record(z.string(), z.number())
    .optional()
    .describe(
      'For MULTIPLE-CHOICE questions: map of option label -> probability, e.g. {"Option A": 0.7, "Option B": 0.3}. ' +
        "Values must sum to 1.0. Option labels must match question.options exactly.",
    ),
  continuous_cdf: z
    .array(z.number())
    .optional()
    .describe(
      "For CONTINUOUS (numeric/date/discrete) questions: a full CDF with inbound_outcome_count+1 " +
        "values (201 for the default 200). If you don't want to construct this yourself, pass " +
        '"percentiles" instead and this server will build a valid CDF for you.',
    ),
  percentiles: z
    .record(z.string(), z.union([z.number(), z.string()]))
    .optional()
    .describe(
      "EASY MODE for continuous questions: a percentile sketch like " +
        '{"5": 120, "25": 300, "50": 470, "75": 700, "95": 1400}. Keys are percentiles (0-100 ' +
        "exclusive); values are in the question's real units (numbers for numeric/discrete, ISO " +
        '8601 datetime strings like "2027-06-30T00:00:00Z" for date questions). The server fetches ' +
        "the question's scaling and converts this into a valid CDF (per the algorithm documented " +
        'in the official API spec). Requires "post_id". If your 5th/95th percentiles do not reach ' +
        "the question's range bounds, also pass probability_below_lower_bound / probability_above_upper_bound.",
    ),
  post_id: z
    .number()
    .int()
    .optional()
    .describe("Required when using \"percentiles\": the post id containing the question (used to fetch scaling data)."),
  probability_below_lower_bound: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "With \"percentiles\": probability mass STRICTLY below the question's lower bound. Must be 0/omitted " +
        "for closed lower bounds; for open lower bounds the API requires at least 0.001 mass below the range " +
        "(the server's standardization guarantees this floor automatically).",
    ),
  probability_above_upper_bound: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("With \"percentiles\": probability mass strictly above the question's upper bound (open upper bounds require at least 0.001)."),
  end_time: z
    .string()
    .optional()
    .describe("Optional ISO 8601 timestamp at which this forecast is automatically withdrawn."),
});

/* ------------------------------------------------------------------ */
/* Server factory                                                      */
/* ------------------------------------------------------------------ */

export function createMetaculusServer(token: string | null): McpServer {
  const server = new McpServer({
    name: "metaculus",
    version: "1.0.0",
  });

  /** Wrap a handler with the token-required check and uniform error handling. */
  const withToken =
    <A>(fn: (token: string, args: A) => Promise<ToolResult>) =>
    async (args: A): Promise<ToolResult> => {
      if (!token) return textResult(NO_TOKEN_MESSAGE, true);
      try {
        return await fn(token, args);
      } catch (err) {
        return errorResult(err);
      }
    };

  /* ---------------- list_questions ---------------- */
  server.registerTool(
    "list_questions",
    {
      title: "List / filter Metaculus questions",
      description:
        "Browse the Metaculus question feed (GET /api/posts/) with structured filters: status " +
        "(open/upcoming/closed/resolved), forecast type (binary, numeric, date, discrete, " +
        "multiple_choice, conditional, group_of_questions), tournament slugs (e.g. a bot-tournament " +
        "slug), category slugs, time-window filters, and ordering (e.g. \"-hotness\" for trending, " +
        "\"scheduled_resolve_time\" for soonest-resolving). Returns compact question summaries " +
        "including the post id needed by get_question and the scaling data needed for continuous " +
        "forecasts. NOTES: the API has no documented free-text search parameter, so filtering is " +
        "structured-only. Community Prediction data (with_cp) is only returned on a limited set of " +
        "questions (~50 for normal accounts; ~250 open + ~250 resolved on Metaculus's free Bot " +
        "Benchmarking Access Tier). order_by=score requires forecaster_id.",
      inputSchema: {
        statuses: z.array(statusesEnum).optional().describe('Post statuses to include, e.g. ["open"].'),
        forecast_type: z.array(forecastTypeEnum).optional().describe('Question types to include, e.g. ["binary"].'),
        tournaments: z.array(z.string()).optional().describe('Tournament slugs, e.g. ["metaculus-cup"].'),
        categories: z.array(z.string()).optional().describe('Category slugs, e.g. ["health-pandemics"].'),
        forecaster_id: z.number().int().optional().describe("Only posts where this user id has an active forecast."),
        not_forecaster_id: z.number().int().optional().describe("Only posts where this user id has NOT forecast (useful for finding new questions to predict)."),
        order_by: orderByEnum.optional().describe('Sort field; "-" prefix = descending. E.g. "-hotness".'),
        limit: z.number().int().min(1).optional().describe("Page size (pagination limit). Keep small (e.g. 10-20) to save context."),
        offset: z.number().int().min(0).optional().describe("Pagination offset."),
        with_cp: z.boolean().optional().describe("Include Community Prediction data where your access tier allows it."),
        include_cp_history: z.boolean().optional().describe("Include full aggregation history (large!)."),
        include_descriptions: z.boolean().optional().describe("Include description / resolution_criteria / fine_print for each question."),
        for_main_feed: z.boolean().optional().describe("Filter to posts suitable for the main feed."),
        open_time__gt: z.string().optional().describe('Only posts opened after this timestamp, e.g. "2026-01-01".'),
        open_time__lt: z.string().optional().describe("Only posts opened before this timestamp."),
        published_at__gt: z.string().optional().describe("Only posts published after this timestamp."),
        published_at__lt: z.string().optional().describe("Only posts published before this timestamp."),
        scheduled_resolve_time__gt: z.string().optional().describe("Only posts scheduled to resolve after this timestamp."),
        scheduled_resolve_time__lt: z.string().optional().describe("Only posts scheduled to resolve before this timestamp."),
        raw: z.boolean().optional().describe("Return the unmodified API JSON instead of compact summaries (verbose)."),
      },
    },
    withToken(async (tok, args: Record<string, unknown>) => {
      const { raw, ...query } = args;
      const data = await metJson<AnyObj>(tok, "/api/posts/", {
        query: { limit: 20, ...query } as never,
      });
      if (raw) return jsonResult(data);
      const results = Array.isArray(data.results) ? data.results : [];
      return jsonResult({
        count_returned: results.length,
        next: data.next ?? null,
        previous: data.previous ?? null,
        results: results.map(slimPost),
      });
    }),
  );

  /* ---------------- get_question ---------------- */
  server.registerTool(
    "get_question",
    {
      title: "Get full question detail",
      description:
        "Fetch one post's full detail (GET /api/posts/{postId}/): complete description, " +
        "resolution criteria, fine print, status, timestamps, subquestions for group/conditional " +
        "posts, and — critically for continuous questions — question.scaling " +
        "(range_min/range_max/zero_point) plus open_lower_bound/open_upper_bound/" +
        "inbound_outcome_count, which are required to construct a valid CDF forecast. Community " +
        "Prediction aggregates appear only where your access tier allows. Use the post id from " +
        "list_questions or from a metaculus.com/questions/<id>/ URL.",
      inputSchema: {
        post_id: z.number().int().describe("The post id (the number in metaculus.com/questions/<id>/)."),
      },
    },
    withToken(async (tok, args: { post_id: number }) => {
      const data = await metJson<AnyObj>(tok, `/api/posts/${args.post_id}/`);
      return jsonResult(data);
    }),
  );

  /* ---------------- get_my_predictions ---------------- */
  server.registerTool(
    "get_my_predictions",
    {
      title: "List questions you have forecast on",
      description:
        "List posts where a given user has submitted forecasts (GET /api/posts/?forecaster_id=...). " +
        "Use it with your own numeric Metaculus user id to review your active book and track " +
        "record; per the API docs your own predictions and scores are always available to you. " +
        "Your numeric user id appears as author.id on your own comments (get_comments with " +
        "author_is_staff omitted), as author_id on your own posts, and in your profile page URL " +
        "on metaculus.com. Combine with statuses=[\"resolved\"] to review resolved outcomes, or " +
        'order_by="-user_last_forecasts_date" (the default here) for most-recently-forecast first.',
      inputSchema: {
        user_id: z.number().int().describe("Your numeric Metaculus user id."),
        statuses: z.array(statusesEnum).optional().describe('Filter by status, e.g. ["open"] for your active book.'),
        order_by: orderByEnum.optional().describe('Defaults to "-user_last_forecasts_date". "score"/"-score" also work here since forecaster_id is set.'),
        limit: z.number().int().min(1).optional().describe("Page size (default 20)."),
        offset: z.number().int().min(0).optional().describe("Pagination offset."),
        with_cp: z.boolean().optional().describe("Include Community Prediction where your tier allows."),
        raw: z.boolean().optional().describe("Return unmodified API JSON."),
      },
    },
    withToken(async (tok, args: Record<string, unknown>) => {
      const { user_id, raw, ...rest } = args;
      const data = await metJson<AnyObj>(tok, "/api/posts/", {
        query: {
          forecaster_id: user_id as number,
          order_by: "-user_last_forecasts_date",
          limit: 20,
          ...rest,
        } as never,
      });
      if (raw) return jsonResult(data);
      const results = Array.isArray(data.results) ? data.results : [];
      return jsonResult({
        count_returned: results.length,
        next: data.next ?? null,
        results: results.map(slimPost),
      });
    }),
  );

  /* ---------------- submit_forecast ---------------- */
  server.registerTool(
    "submit_forecast",
    {
      title: "Submit forecast(s)",
      description:
        "Submit one or many forecasts in a single call (POST /api/questions/forecast/). Supports " +
        "all Metaculus question types: BINARY (pass probability_yes), MULTIPLE-CHOICE (pass " +
        "probability_yes_per_category summing to 1.0), and CONTINUOUS numeric/date/discrete " +
        "questions (pass a full continuous_cdf, or — much easier — pass \"percentiles\" plus " +
        "post_id and the server builds a spec-valid CDF for you, handling linear/log scaling, " +
        "open/closed bounds, and minimum-slope rules automatically). For conditional questions " +
        "pass one item per branch; for group questions pass one item per subquestion. Forecasts " +
        "stand until withdrawn (withdraw_forecast) or until the optional end_time. Tip: fetch " +
        "get_question first to read resolution criteria and get exact question ids and option labels.",
      inputSchema: {
        forecasts: z.array(forecastItemSchema).min(1).describe("One or more forecast items."),
      },
    },
    withToken(async (tok, args: { forecasts: Array<z.infer<typeof forecastItemSchema>> }) => {
      const payload: AnyObj[] = [];
      const notes: string[] = [];

      for (const item of args.forecasts) {
        const { percentiles, post_id, probability_below_lower_bound, probability_above_upper_bound, ...rest } = item;
        const entry: AnyObj = { question: rest.question };
        if (rest.probability_yes !== undefined) entry.probability_yes = rest.probability_yes;
        if (rest.probability_yes_per_category !== undefined) {
          entry.probability_yes_per_category = rest.probability_yes_per_category;
        }
        if (rest.end_time !== undefined) entry.end_time = rest.end_time;

        if (rest.continuous_cdf !== undefined) {
          entry.continuous_cdf = rest.continuous_cdf;
        } else if (percentiles !== undefined) {
          if (post_id === undefined) {
            return textResult(
              `Forecast for question ${rest.question}: "percentiles" requires "post_id" so the ` +
                "server can fetch the question's scaling data.",
              true,
            );
          }
          const post = await metJson<AnyObj>(tok, `/api/posts/${post_id}/`);
          const question = findQuestionInPost(post, rest.question);
          if (!question) {
            return textResult(
              `Question id ${rest.question} not found inside post ${post_id}. Use get_question ` +
                "on that post to see its question ids (group/conditional posts contain several).",
              true,
            );
          }
          const cdf = buildCdfFromPercentiles(
            percentiles,
            question,
            probability_below_lower_bound,
            probability_above_upper_bound,
          );
          entry.continuous_cdf = cdf;
          notes.push(
            `question ${rest.question}: built a ${cdf.length}-point CDF from your percentile sketch.`,
          );
        }

        if (
          entry.probability_yes === undefined &&
          entry.probability_yes_per_category === undefined &&
          entry.continuous_cdf === undefined
        ) {
          return textResult(
            `Forecast for question ${rest.question} has no prediction. Provide probability_yes ` +
              "(binary), probability_yes_per_category (multiple-choice), or continuous_cdf / " +
              "percentiles (continuous).",
            true,
          );
        }
        if (entry.continuous_cdf !== undefined && percentiles === undefined && post_id !== undefined) {
          // Optional client-provided CDF validation when we can fetch scaling cheaply.
          try {
            const post = await metJson<AnyObj>(tok, `/api/posts/${post_id}/`);
            const question = findQuestionInPost(post, rest.question);
            if (question) validateCdf(entry.continuous_cdf as number[], question);
          } catch (e) {
            if (e instanceof Error && !(e instanceof MetaculusApiError)) {
              return textResult(`CDF validation failed for question ${rest.question}: ${e.message}`, true);
            }
          }
        }
        payload.push(entry);
      }

      const response = await metFetch(tok, "/api/questions/forecast/", {
        method: "POST",
        body: payload,
      });
      const bodyText = await response.text();
      return textResult(
        `Submitted ${payload.length} forecast(s) — HTTP ${response.status}.` +
          (notes.length ? `\n${notes.join("\n")}` : "") +
          (bodyText ? `\nAPI response: ${bodyText.slice(0, 2000)}` : ""),
      );
    }),
  );

  /* ---------------- withdraw_forecast ---------------- */
  server.registerTool(
    "withdraw_forecast",
    {
      title: "Withdraw forecast(s)",
      description:
        "Withdraw your current standing forecast on one or more questions (POST " +
        "/api/questions/withdraw/). After withdrawal you stop accruing scores on the question " +
        "from that point. Pass QUESTION ids (for group/conditional posts, each subquestion id " +
        "separately — same ids used by submit_forecast).",
      inputSchema: {
        question_ids: z.array(z.number().int()).min(1).describe("Question ids to withdraw from."),
      },
    },
    withToken(async (tok, args: { question_ids: number[] }) => {
      const response = await metFetch(tok, "/api/questions/withdraw/", {
        method: "POST",
        body: args.question_ids.map((id) => ({ question: id })),
      });
      const bodyText = await response.text();
      return textResult(
        `Withdrew forecasts on ${args.question_ids.length} question(s) — HTTP ${response.status}.` +
          (bodyText ? `\nAPI response: ${bodyText.slice(0, 2000)}` : ""),
      );
    }),
  );

  /* ---------------- post_comment ---------------- */
  server.registerTool(
    "post_comment",
    {
      title: "Post a comment",
      description:
        "Publish a comment on a Metaculus post (POST /api/comments/create/) — e.g. a forecast " +
        "rationale, which Metaculus's AI Forecasting Benchmark tournaments encourage bots to " +
        "post alongside predictions. Supports replying to an existing comment via \"parent\", " +
        "private comments (visible only to you) via is_private, and attaching your latest " +
        "forecast via included_forecast. Comments are public by default — write accordingly.",
      inputSchema: {
        on_post: z.number().int().describe("The post id to comment on."),
        text: z.string().min(1).describe("Comment body (Markdown is used on metaculus.com)."),
        is_private: z.boolean().optional().describe("true = visible only to you (default false = public)."),
        included_forecast: z.boolean().optional().describe("true = attach your latest forecast to the comment (default false)."),
        parent: z.number().int().optional().describe("Comment id to reply to (omit for a top-level comment)."),
      },
    },
    withToken(async (tok, args: { on_post: number; text: string; is_private?: boolean; included_forecast?: boolean; parent?: number }) => {
      const body: AnyObj = {
        on_post: args.on_post,
        text: args.text,
        is_private: args.is_private ?? false,
        included_forecast: args.included_forecast ?? false,
      };
      if (args.parent !== undefined) body.parent = args.parent;
      const data = await metJson<AnyObj>(tok, "/api/comments/create/", {
        method: "POST",
        body,
      });
      return jsonResult({ created: true, comment: data });
    }),
  );

  /* ---------------- get_comments ---------------- */
  server.registerTool(
    "get_comments",
    {
      title: "Read comments",
      description:
        "Fetch comments (GET /api/comments/), e.g. staff resolution notes on a question or your " +
        "own past rationales. ACCESS RULE from the official spec: when API access is restricted " +
        "(the normal case), each request must filter by author=<your own user id> and/or " +
        "author_is_staff=true — unfiltered requests are rejected. author_is_staff=true returns " +
        "root-level staff comments (their replies to others are not included); combined with " +
        "author it acts as an OR filter.",
      inputSchema: {
        post: z.number().int().optional().describe("Restrict to comments on this post id."),
        author: z.number().int().optional().describe("Filter by author user id — use your own id to read your comments."),
        author_is_staff: z.boolean().optional().describe("true = include root-level comments by Metaculus staff."),
        limit: z.number().int().min(1).optional().describe("Number of comments to return (default 20)."),
        offset: z.number().int().min(0).optional().describe("Pagination offset."),
        sort: z.enum(["created_at", "-created_at"]).optional().describe('"-created_at" = newest first.'),
        is_private: z.boolean().optional().describe("true = your private comments instead of public ones (default false)."),
        use_root_comments_pagination: z.boolean().optional().describe("Paginate root comments only, including all their replies."),
        focus_comment_id: z.number().int().optional().describe("Comment id to place at the top of results."),
      },
    },
    withToken(async (tok, args: Record<string, unknown>) => {
      const data = await metJson<AnyObj>(tok, "/api/comments/", {
        query: { limit: 20, ...args } as never,
      });
      return jsonResult(data);
    }),
  );

  /* ---------------- download_question_data ---------------- */
  server.registerTool(
    "download_question_data",
    {
      title: "Download question/forecast data (CSV export)",
      description:
        "Pull Metaculus's CSV data export for a post, question, or project (GET " +
        "/api/data/download/ — a Zip of CSVs: question data, forecast data, and optionally your " +
        "scores and comments) and return parsed rows, so you can analyze forecast history and " +
        "your own scoring track record. IMPORTANT CAVEAT from the official spec: this is a " +
        "RESTRICTED endpoint — accounts generally need data access granted via the Metaculus " +
        "Data Needs Form (linked in the API docs at metaculus.com/api/), and project_id " +
        "additionally requires per-project whitelisting. Expect an error if your account lacks " +
        "access. Large exports may time out server-side.",
      inputSchema: {
        post_id: z.number().int().optional().describe("Post id to export (provide at least one of post_id / question_id / project_id)."),
        question_id: z.number().int().optional().describe("Question id to export."),
        project_id: z.number().int().optional().describe("Project id to export (requires per-project whitelisting)."),
        sub_question: z.number().int().optional().describe("For group/conditional posts: restrict to one sub-question id."),
        aggregation_methods: z.string().optional().describe('Comma-separated aggregation methods to include ("recency_weighted", "unweighted", "metaculus_prediction") or "all". Triggers recalculation (slower).'),
        include_scores: z.boolean().optional().describe("Include the scores CSV (default true per the API)."),
        include_comments: z.boolean().optional().describe("Include the public-comments CSV (default false; can be large)."),
        include_key_factors: z.boolean().optional().describe("Include key-factors data (default false)."),
        include_bots: z.boolean().optional().describe("Include bot forecasts in recalculated aggregations (requires aggregation_methods)."),
        user_ids: z.array(z.number().int()).optional().describe("Restrict recalculated aggregations to these user ids (staff/whitelisted accounts only)."),
        max_rows_per_file: z.number().int().min(1).max(2000).optional().describe("Cap on parsed rows returned per CSV file (default 50). Full row counts are always reported."),
      },
    },
    withToken(async (tok, args: Record<string, unknown>) => {
      const { max_rows_per_file, ...query } = args;
      if (query.post_id === undefined && query.question_id === undefined && query.project_id === undefined) {
        return textResult(
          "Provide at least one of post_id, question_id, or project_id (API requirement).",
          true,
        );
      }
      const maxRows = (max_rows_per_file as number | undefined) ?? 50;
      const response = await metFetch(tok, "/api/data/download/", { query: query as never });
      const buffer = new Uint8Array(await response.arrayBuffer());
      let files: Record<string, Uint8Array>;
      try {
        files = unzipSync(buffer);
      } catch {
        return textResult(
          `The API response could not be unzipped (content-type: ${response.headers.get("content-type") ?? "unknown"}, ` +
            `${buffer.byteLength} bytes). First bytes as text: ${strFromU8(buffer.slice(0, 500))}`,
          true,
        );
      }
      const out: AnyObj[] = [];
      for (const [name, data] of Object.entries(files)) {
        if (name.toLowerCase().endsWith(".csv")) {
          const rows = parseCsv(strFromU8(data)).filter((r) => !(r.length === 1 && r[0] === ""));
          const header = rows[0] ?? [];
          const body = rows.slice(1);
          out.push({
            file: name,
            total_data_rows: body.length,
            header,
            rows: body.slice(0, maxRows),
            truncated: body.length > maxRows,
          });
        } else {
          out.push({ file: name, note: "non-CSV file; skipped", bytes: data.byteLength });
        }
      }
      return jsonResult({ files: out });
    }),
  );

  return server;
}
