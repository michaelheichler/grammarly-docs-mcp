#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  LOCAL_GRAMMARLY_FEATURES,
  listLocalGrammarlyFeatures,
  openLocalGrammarlyLogin,
  runLocalGrammarlyFeature,
} from "./browser/localPlaywrightProvider";
import { config, log } from "./config";
import {
  type GrammarlyOptimizeInput,
  type GrammarlyOptimizeResult,
  type ProgressCallback,
  runGrammarlyOptimization,
  ToolInputSchema,
  ToolOutputSchema,
} from "./grammarlyOptimizer";

const GrammarlyFeatureSchema = z.enum(LOCAL_GRAMMARLY_FEATURES);

const TextMetricsSchema = z.object({
  words: z.number().int().nonnegative(),
  characters: z.number().int().nonnegative(),
  charactersNoSpaces: z.number().int().nonnegative(),
  sentences: z.number().int().nonnegative(),
  paragraphs: z.number().int().nonnegative(),
  grammarlyWordCount: z.number().int().nonnegative().nullable(),
});

const GrammarlyFeatureScoresSchema = z.object({
  writingQuality: z.number().nullable(),
  aiDetectionPercent: z.number().nullable(),
  plagiarismPercent: z.number().nullable(),
});

const GrammarlyFeatureResultSchema = z.object({
  feature: GrammarlyFeatureSchema,
  available: z.boolean(),
  loggedIn: z.boolean(),
  finalUrl: z.string(),
  panelText: z.string(),
  documentText: z.string(),
  scores: GrammarlyFeatureScoresSchema,
  metrics: TextMetricsSchema,
  notes: z.string(),
});

const GrammarlyFeatureSummarySchema = z.object({
  id: GrammarlyFeatureSchema,
  label: z.string(),
  kind: z.enum(["agent", "proofreader-capability", "metric"]),
  localDocsAvailable: z.boolean(),
  notes: z.string(),
});

/**
 * Format optimization result as human-readable markdown.
 */
export function formatAsMarkdown(result: GrammarlyOptimizeResult): string {
  const statusEmoji = result.thresholds_met ? "✅" : "⚠️";
  const aiScore =
    result.ai_detection_percent !== null
      ? `${result.ai_detection_percent}%`
      : "N/A";
  const plagiarismScore =
    result.plagiarism_percent !== null
      ? `${result.plagiarism_percent}%`
      : "N/A";

  const lines: string[] = [
    `# Grammarly Optimization Result ${statusEmoji}`,
    "",
    "## Summary",
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| AI Detection | ${aiScore} |`,
    `| Plagiarism | ${plagiarismScore} |`,
    `| Thresholds Met | ${result.thresholds_met ? "Yes" : "No"} |`,
    `| Iterations Used | ${result.iterations_used} |`,
  ];

  if (result.live_url) {
    lines.push(`| Live Preview | [Browser Session](${result.live_url}) |`);
  }

  lines.push("", "## Notes", "", result.notes);

  if (result.history.length > 0) {
    lines.push("", "## Iteration History", "");
    lines.push("| Iteration | AI % | Plagiarism % | Note |");
    lines.push("|-----------|------|--------------|------|");
    for (const entry of result.history) {
      const ai =
        entry.ai_detection_percent !== null
          ? `${entry.ai_detection_percent}%`
          : "N/A";
      const plag =
        entry.plagiarism_percent !== null
          ? `${entry.plagiarism_percent}%`
          : "N/A";
      // Truncate long notes for table readability
      const note =
        entry.note.length > 60 ? `${entry.note.slice(0, 57)}...` : entry.note;
      lines.push(`| ${entry.iteration} | ${ai} | ${plag} | ${note} |`);
    }
  }

  lines.push(
    "",
    "---",
    "",
    "## Final Text",
    "",
    "```",
    result.final_text,
    "```",
  );

  return lines.join("\n");
}

/**
 * Create and configure the MCP server.
 *
 * This server implements MCP specification 2025-11-25 with:
 * - registerTool() API (replaces deprecated tool())
 * - Tool annotations for client hints
 * - Output schema for structured responses
 * - Tasks support for async operations (experimental)
 * - Progress notifications during long operations
 */
async function main(): Promise<void> {
  const server = new McpServer(
    {
      name: "grammarly-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        logging: {},
      },
    },
  );

  server.registerTool(
    "grammarly_open_login_browser",
    {
      title: "Open Local Grammarly Login Browser",
      description:
        "Open a local Playwright-controlled browser using the persistent Grammarly MCP profile. " +
        "Use this once to log into Grammarly locally before calling grammarly_optimize_text with BROWSER_PROVIDER=local-playwright.",
      inputSchema: {
        wait_seconds: z
          .number()
          .int()
          .min(10)
          .max(600)
          .default(180)
          .describe(
            "How long to keep the login browser open before returning. Log into Grammarly during this window.",
          ),
      },
      outputSchema: {
        profile_dir: z.string(),
        final_url: z.string(),
        logged_in: z.boolean(),
        notes: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const input = z
        .object({
          wait_seconds: z.number().int().min(10).max(600).default(180),
        })
        .parse(args);

      const result = await openLocalGrammarlyLogin(config, input.wait_seconds);
      const structuredContent = {
        profile_dir: result.profileDir,
        final_url: result.finalUrl,
        logged_in: result.loggedIn,
        notes: result.loggedIn
          ? "The local Grammarly profile appears logged in."
          : "The local Grammarly profile does not appear logged in yet. Run this tool again and complete login in the opened browser.",
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(structuredContent, null, 2),
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "grammarly_list_features",
    {
      title: "List Grammarly Features",
      description:
        "Inspect the local Grammarly Docs UI and list the Grammarly agents and checker capabilities this MCP server can drive.",
      inputSchema: {},
      outputSchema: {
        loggedIn: z.boolean(),
        finalUrl: z.string(),
        features: z.array(GrammarlyFeatureSummarySchema),
        notes: z.string(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      const result = await listLocalGrammarlyFeatures(config);
      const structuredContent = {
        loggedIn: result.loggedIn,
        finalUrl: result.finalUrl,
        features: result.features,
        notes: result.notes,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(structuredContent, null, 2),
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "grammarly_run_feature",
    {
      title: "Run Grammarly Feature",
      description:
        "Run one Grammarly Docs feature against text through the local browser profile. Supports Proofreader capabilities plus AI Chat, Paraphraser, Reader Reactions, Humanizer, Citation, AI Detector, AI Rewriter, Plagiarism Checker, AI Grader, and Authorship when exposed by the logged-in account.",
      inputSchema: {
        feature: GrammarlyFeatureSchema.describe(
          "The Grammarly feature or agent to open.",
        ),
        text: z.string().min(1).describe("Text to place into Grammarly Docs."),
        instruction: z
          .string()
          .optional()
          .describe(
            "Optional prompt for interactive Grammarly agents such as AI Chat, Paraphraser, Humanizer, Citation, AI Rewriter, or AI Grader.",
          ),
      },
      outputSchema: GrammarlyFeatureResultSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const input = z
        .object({
          feature: GrammarlyFeatureSchema,
          text: z.string().min(1),
          instruction: z.string().optional(),
        })
        .parse(args);

      log("info", "Received grammarly_run_feature tool call", {
        feature: input.feature,
      });

      const result = await runLocalGrammarlyFeature(
        config,
        input.feature,
        input.text,
        input.instruction,
      );
      const structuredContent = GrammarlyFeatureResultSchema.parse({
        feature: result.feature,
        available: result.available,
        loggedIn: result.loggedIn,
        finalUrl: result.finalUrl,
        panelText: result.panelText,
        documentText: result.documentText,
        scores: result.scores,
        metrics: result.metrics,
        notes: result.notes,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(structuredContent, null, 2),
          },
        ],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "grammarly_optimize_text",
    {
      title: "Grammarly Text Optimizer",
      description:
        "Get AI detection and plagiarism scores from Grammarly, optionally rewriting text with the configured LLM to reduce scores. " +
        "Modes: 'score_only' (scores only), 'analyze' (scores + recommendations), 'optimize' (iterative rewriting to meet thresholds).",
      inputSchema: ToolInputSchema,
      outputSchema: ToolOutputSchema,
      annotations: {
        readOnlyHint: false, // Tool can rewrite text
        destructiveHint: false, // Non-destructive (original preserved in input)
        idempotentHint: false, // Each run may produce different results
        openWorldHint: true, // Interacts with Grammarly and external LLM APIs
      },
    },
    async (args, extra) => {
      const parsed = ToolInputSchema.parse(args) as GrammarlyOptimizeInput;

      log("info", "Received grammarly_optimize_text tool call", {
        mode: parsed.mode,
        max_ai_percent: parsed.max_ai_percent,
        max_plagiarism_percent: parsed.max_plagiarism_percent,
        max_iterations: parsed.max_iterations,
      });

      // Create progress callback for MCP progress notifications.
      // Prefer a public accessor if available (MCP SDK >=1.25.x expected to expose a getter;
      // see README), and only fall back to the private `_meta` escape hatch when nothing
      // else exists.
      // Allow either the public getter (preferred) or fall back to legacy fields.
      type ProgressTokenCarrier = {
        getProgressToken?: () => unknown;
        progressToken?: unknown;
        meta?: { progressToken?: unknown };
        /** legacy/private hook */
        // biome-ignore lint/style/useNamingConvention: external SDK uses _meta for request metadata
        _meta?: { progressToken?: unknown };
      };
      const progressTokenCarrier = extra as unknown as ProgressTokenCarrier;
      const progressTokenCandidate =
        typeof progressTokenCarrier.getProgressToken === "function"
          ? progressTokenCarrier.getProgressToken()
          : (progressTokenCarrier.progressToken ??
            progressTokenCarrier.meta?.progressToken ??
            // Legacy/private path: keep guarded to avoid hard-coupling to internals.
            progressTokenCarrier._meta?.progressToken);
      const progressToken =
        typeof progressTokenCandidate === "string" ||
        typeof progressTokenCandidate === "number"
          ? progressTokenCandidate
          : undefined;
      const onProgress: ProgressCallback = async (message, progress) => {
        if (extra.sendNotification && progressToken) {
          try {
            await extra.sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: progress ?? 0,
                total: 100,
                message,
              },
            });
          } catch (err) {
            log("debug", "Failed to send progress notification", {
              error: err instanceof Error ? err.message : err,
            });
          }
        }
        log("debug", `Progress: ${message}`, { progress });
      };

      const result = await runGrammarlyOptimization(config, parsed, onProgress);
      const validatedOutput = ToolOutputSchema.parse(result);

      // Format output based on response_format preference
      // Use result (GrammarlyOptimizeResult) for formatting, validatedOutput for structuredContent
      const textSummary =
        parsed.response_format === "markdown"
          ? formatAsMarkdown(result)
          : JSON.stringify(validatedOutput, null, 2);

      return {
        content: [
          {
            type: "text",
            text: textSummary,
          },
        ],
        structuredContent: validatedOutput,
      };
    },
  );

  const transport = new StdioServerTransport();

  log("info", "Starting Grammarly MCP server over stdio");

  const timeoutMs = config.connectTimeoutMs;
  const connectPromise = server.connect(transport);

  let timeoutHandle: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Server connect timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([connectPromise, timeoutPromise]);
  } catch (error: unknown) {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    log("error", "Failed to start MCP server", {
      message: error instanceof Error ? error.message : String(error),
    });

    // Attempt to clean up the transport if it exposes a close method.
    const maybeClose = (transport as { close?: () => unknown }).close;
    if (typeof maybeClose === "function") {
      try {
        await maybeClose();
      } catch {
        // Ignore cleanup errors
      }
    }

    process.exit(1);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

// Top-level await is supported in Node 18+ ESM.
void main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error("Fatal error:", error.message);
    console.error(error.stack ?? "(no stack trace)");
  } else {
    console.error("Fatal error (non-Error):", error);
  }
  process.exit(1);
});
