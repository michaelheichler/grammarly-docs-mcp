import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type BrowserContext,
  chromium,
  type Locator,
  type Page,
} from "playwright";
import type { AppConfig } from "../config";
import { log } from "../config";
import type {
  BrowserProvider,
  GrammarlyScoreResult,
  ScoreOptions,
  SessionResult,
} from "./provider";

const GRAMMARLY_HOME = "https://app.grammarly.com/";
const DEFAULT_LOGIN_WAIT_MS = 120_000;

export const LOCAL_GRAMMARLY_FEATURES = [
  "proofreader",
  "grammar-checker",
  "spell-checker",
  "punctuation-checker",
  "tone-detector",
  "word-counter",
  "character-counter",
  "paragraph-counter",
  "sentence-counter",
  "sentence-checker",
  "passive-voice-checker",
  "essay-checker",
  "ai-writing-tools",
  "ai-chat",
  "paraphraser",
  "paraphrasing-tool",
  "reader-reactions",
  "humanizer",
  "ai-humanizer",
  "citation",
  "citation-generator",
  "citation-finder",
  "ai-detector",
  "ai-rewriter",
  "plagiarism-checker",
  "ai-grader",
  "authorship",
  "resume-builder",
  "style-guide",
  "snippets",
  "analytics",
  "brand-tones",
] as const;

export type LocalGrammarlyFeatureId = (typeof LOCAL_GRAMMARLY_FEATURES)[number];

export type LocalGrammarlyFeatureResult = {
  feature: LocalGrammarlyFeatureId;
  available: boolean;
  loggedIn: boolean;
  finalUrl: string;
  panelText: string;
  documentText: string;
  rewrittenText: string | null;
  scores: {
    writingQuality: number | null;
    aiDetectionPercent: number | null;
    plagiarismPercent: number | null;
  };
  metrics: TextMetrics;
  notes: string;
};

export type LocalGrammarlyFeatureSummary = {
  id: LocalGrammarlyFeatureId;
  label: string;
  kind: "agent" | "proofreader-capability" | "metric";
  localDocsAvailable: boolean;
  notes: string;
};

type TextMetrics = {
  words: number;
  characters: number;
  charactersNoSpaces: number;
  sentences: number;
  paragraphs: number;
  grammarlyWordCount: number | null;
};

type LocalSession = {
  context: BrowserContext;
  page: Page;
  profileDir: string;
  removeProfileOnClose: boolean;
};

export type LaunchSessionOptions = {
  forceHeaded?: boolean;
  useSharedProfile?: boolean;
};

export type SessionProfilePlan = {
  profileDir: string;
  removeProfileOnClose: boolean;
};

const profileCopySkippedNames = new Set([
  "BrowserMetrics",
  "Cache",
  "Code Cache",
  "Crashpad",
  "DawnCache",
  "GPUCache",
  "GrShaderCache",
  "Safe Browsing",
  "ShaderCache",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
  "component_crx_cache",
  "lockfile",
]);

export class LocalPlaywrightProvider implements BrowserProvider {
  readonly providerName = "local-playwright" as const;

  private readonly config: AppConfig;
  private readonly sessions = new Map<string, LocalSession>();

  constructor(config: AppConfig) {
    this.config = config;
  }

  async createSession(): Promise<SessionResult> {
    const session = await this.launchSession();
    const sessionId = `local-${randomUUID()}`;
    this.sessions.set(sessionId, session);

    await session.page.goto(GRAMMARLY_HOME, {
      waitUntil: "domcontentloaded",
      timeout: this.config.connectTimeoutMs,
    });
    await session.page.waitForTimeout(2_000);

    return {
      sessionId,
      liveUrl: session.page.url(),
    };
  }

  async scoreText(
    sessionId: string,
    text: string,
    _options?: ScoreOptions,
  ): Promise<GrammarlyScoreResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`No local Playwright session found: ${sessionId}`);
    }

    const page = session.page;
    await this.ensureGrammarlyHome(page);

    const loginState = await this.detectLoginState(page);
    if (!loginState.loggedIn) {
      return {
        aiDetectionPercent: null,
        plagiarismPercent: null,
        notes:
          "Local Grammarly browser is not logged in. Run grammarly_open_login_browser, log in, then retry.",
        liveUrl: page.url(),
      };
    }

    const created = await this.openNewDocument(page);
    if (!created.ok) {
      return {
        aiDetectionPercent: null,
        plagiarismPercent: null,
        notes: created.notes,
        liveUrl: page.url(),
      };
    }

    await this.fillEditor(page, text);

    const visibleTextSnapshots: string[] = [];
    await this.tryOpenAiDetectorPanel(page);
    await page.waitForTimeout(8_000);
    visibleTextSnapshots.push(await getBodyText(page));

    await this.tryOpenPlagiarismPanel(page);
    await page.waitForTimeout(10_000);
    visibleTextSnapshots.push(await getBodyText(page));

    const bodyText = visibleTextSnapshots.join("\n\n");
    const aiDetectionPercent = extractAiPercent(bodyText);
    const plagiarismPercent = extractPlagiarismPercent(bodyText);

    return {
      aiDetectionPercent,
      plagiarismPercent,
      notes: buildExtractionNotes(
        bodyText,
        aiDetectionPercent,
        plagiarismPercent,
      ),
      liveUrl: page.url(),
    };
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    this.sessions.delete(sessionId);
    await closeLocalSession(session);
  }

  async openLoginBrowser(waitMs = DEFAULT_LOGIN_WAIT_MS): Promise<{
    profileDir: string;
    finalUrl: string;
    loggedIn: boolean;
  }> {
    const session = await this.launchSession({
      forceHeaded: true,
      useSharedProfile: true,
    });
    try {
      await session.page.goto(GRAMMARLY_HOME, {
        waitUntil: "domcontentloaded",
        timeout: this.config.connectTimeoutMs,
      });
      await session.page.waitForTimeout(waitMs);
      const loginState = await this.detectLoginState(session.page);
      return {
        profileDir: this.config.localBrowserProfileDir,
        finalUrl: session.page.url(),
        loggedIn: loginState.loggedIn,
      };
    } finally {
      await closeLocalSession(session);
    }
  }

  async listFeatures(): Promise<{
    loggedIn: boolean;
    finalUrl: string;
    features: LocalGrammarlyFeatureSummary[];
    notes: string;
  }> {
    const session = await this.launchSession();
    try {
      await this.ensureGrammarlyHome(session.page);
      const loginState = await this.detectLoginState(session.page);
      if (!loginState.loggedIn) {
        return {
          loggedIn: false,
          finalUrl: session.page.url(),
          features: buildFeatureSummaries(new Set()),
          notes:
            "Local Grammarly browser is not logged in. Run grammarly_open_login_browser, log in, then retry.",
        };
      }

      const created = await this.openNewDocument(session.page);
      if (!created.ok) {
        return {
          loggedIn: true,
          finalUrl: session.page.url(),
          features: buildFeatureSummaries(new Set()),
          notes: created.notes,
        };
      }

      await revealAgentBench(session.page);
      const visibleAgentLabels = await collectVisibleAgentLabels(session.page);
      return {
        loggedIn: true,
        finalUrl: session.page.url(),
        features: buildFeatureSummaries(visibleAgentLabels),
        notes: `Detected Grammarly Docs agent controls: ${Array.from(visibleAgentLabels).join(", ") || "none"}.`,
      };
    } finally {
      await closeLocalSession(session);
    }
  }

  async runFeature(
    feature: LocalGrammarlyFeatureId,
    text: string,
    instruction?: string,
  ): Promise<LocalGrammarlyFeatureResult> {
    const session = await this.launchSession();
    try {
      const page = session.page;
      await this.ensureGrammarlyHome(page);

      const loginState = await this.detectLoginState(page);
      if (!loginState.loggedIn) {
        return buildFeatureResult({
          feature,
          available: false,
          loggedIn: false,
          finalUrl: page.url(),
          bodyText:
            "Local Grammarly browser is not logged in. Run grammarly_open_login_browser, log in, then retry.",
          documentText: text,
          notes:
            "Local Grammarly browser is not logged in. Run grammarly_open_login_browser, log in, then retry.",
        });
      }

      const created = await this.openNewDocument(page);
      if (!created.ok) {
        return buildFeatureResult({
          feature,
          available: false,
          loggedIn: true,
          finalUrl: page.url(),
          bodyText: created.notes,
          documentText: text,
          notes: created.notes,
        });
      }

      await this.fillEditor(page, text);
      const opened = await this.openFeaturePanel(page, feature);
      let rewriteStatus: RewriteAcceptanceStatus = "not-applicable";
      let rewrittenText: string | null = null;

      if (rewriteProducingFeatures.has(feature)) {
        await page.waitForTimeout(featureWaitMs(feature));
        rewriteStatus = await tryAcceptRelevantRewriteSuggestion(page, text);

        if (rewriteStatus !== "accepted") {
          const prompt = buildRewriteAgentPrompt(feature, text, instruction);
          const sent = await this.applyFeatureInstruction(
            page,
            feature,
            prompt,
          );
          if (sent) {
            rewrittenText = await waitForAgentRewrite({
              page,
              prompt,
              originalText: text,
              timeoutMs: 45_000,
            });
          }

          if (rewrittenText) {
            rewriteStatus = "chat-extracted";
          } else {
            const fallbackStatus = await tryAcceptRelevantRewriteSuggestion(
              page,
              text,
            );
            if (fallbackStatus !== "not-found") {
              rewriteStatus = fallbackStatus;
            }
          }
        }
      } else {
        await this.applyFeatureInstruction(page, feature, instruction);
        await page.waitForTimeout(featureWaitMs(feature));
      }

      const bodyText = await getBodyText(page);
      const documentText = await getDocumentText(page, text);
      return buildFeatureResult({
        feature,
        available: opened,
        loggedIn: true,
        finalUrl: page.url(),
        bodyText,
        documentText,
        rewrittenText,
        notes: buildRunFeatureNotes({
          opened,
          rewriteStatus,
          rewriteProducing: rewriteProducingFeatures.has(feature),
        }),
      });
    } finally {
      await closeLocalSession(session);
    }
  }

  private async launchSession(
    options: LaunchSessionOptions = {},
  ): Promise<LocalSession> {
    const profilePlan = prepareSessionProfile(this.config, options);

    const baseOptions = {
      headless: options.forceHeaded ? false : this.config.localBrowserHeadless,
      viewport: { width: 1440, height: 1000 },
      args: ["--disable-blink-features=AutomationControlled"],
      ...(this.config.localBrowserExecutable
        ? { executablePath: this.config.localBrowserExecutable }
        : {}),
    };

    try {
      const context = await chromium.launchPersistentContext(
        profilePlan.profileDir,
        {
          ...baseOptions,
          ...(this.config.localBrowserChannel
            ? { channel: this.config.localBrowserChannel }
            : {}),
        },
      );
      return {
        context,
        page: await ensurePage(context),
        profileDir: profilePlan.profileDir,
        removeProfileOnClose: profilePlan.removeProfileOnClose,
      };
    } catch (error) {
      if (
        this.config.localBrowserChannel ||
        this.config.localBrowserExecutable
      ) {
        cleanupSessionProfile(profilePlan);
        throw error;
      }

      log(
        "warn",
        "Default Playwright Chromium launch failed; trying Chrome channel",
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
      try {
        const context = await chromium.launchPersistentContext(
          profilePlan.profileDir,
          {
            ...baseOptions,
            channel: "chrome",
          },
        );
        return {
          context,
          page: await ensurePage(context),
          profileDir: profilePlan.profileDir,
          removeProfileOnClose: profilePlan.removeProfileOnClose,
        };
      } catch (fallbackError) {
        cleanupSessionProfile(profilePlan);
        throw fallbackError;
      }
    }
  }

  private async ensureGrammarlyHome(page: Page): Promise<void> {
    if (!page.url().includes("grammarly.com")) {
      await page.goto(GRAMMARLY_HOME, {
        waitUntil: "domcontentloaded",
        timeout: this.config.connectTimeoutMs,
      });
      await page.waitForTimeout(2_000);
    }
  }

  private async detectLoginState(page: Page): Promise<{ loggedIn: boolean }> {
    const bodyText = await getBodyText(page);
    const loggedOut =
      /sign up|log in|i have an account|continue with google|continue with apple/i.test(
        bodyText,
      );
    const loggedIn =
      /new doc|my documents|docs|trash|sign out|admin panel/i.test(bodyText) &&
      !loggedOut;

    return { loggedIn };
  }

  private async openNewDocument(page: Page): Promise<{
    ok: boolean;
    notes: string;
  }> {
    await page.goto(GRAMMARLY_HOME, {
      waitUntil: "domcontentloaded",
      timeout: this.config.connectTimeoutMs,
    });
    await page.waitForTimeout(2_000);

    const clicked = await clickFirstVisible([
      page.getByRole("button", { name: /new doc/i }),
      page.getByRole("link", { name: /new doc/i }),
      page.getByText(/^New doc$/i),
      page.locator('a[href*="/d/"]').first(),
    ]);

    if (!clicked) {
      const bodyText = await getBodyText(page);
      return {
        ok: false,
        notes: `Could not find Grammarly's New doc control in the local browser. Visible page text: ${summarizeText(bodyText)}`,
      };
    }

    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(6_000);

    const bodyText = await getBodyText(page);
    if (
      /we found a problem|network security issue|reload doc/i.test(bodyText)
    ) {
      return {
        ok: false,
        notes: `Grammarly opened a document but reported an internal/network-security issue: ${summarizeText(bodyText)}`,
      };
    }

    return { ok: true, notes: "New Grammarly document opened." };
  }

  private async fillEditor(page: Page, text: string): Promise<void> {
    const editor = page.locator('[contenteditable="true"]').first();
    await editor.waitFor({ state: "visible", timeout: 30_000 });
    await editor.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.insertText(text.slice(0, 8_000));
    await page.waitForTimeout(2_000);
  }

  private async tryOpenAiDetectorPanel(page: Page): Promise<void> {
    await clickFirstVisible([
      page.getByRole("button", { name: /open ai detector agent/i }),
      page.getByRole("button", { name: /^ai detector$/i }),
      page.locator('[role="button"][aria-label*="AI detector" i]'),
      page.locator('button[aria-label*="AI Detector" i]'),
      page.getByText(/check for ai text|ai detector|ai-generated/i),
    ]);
  }

  private async tryOpenPlagiarismPanel(page: Page): Promise<void> {
    await clickFirstVisible([
      page.getByRole("button", { name: /^plagiarism checker$/i }),
      page.locator('[role="button"][aria-label*="Plagiarism" i]'),
      page.locator('button[aria-label*="Plagiarism" i]'),
      page.getByText(/plagiarism|originality|copied text/i),
    ]);
  }

  private async openFeaturePanel(
    page: Page,
    feature: LocalGrammarlyFeatureId,
  ): Promise<boolean> {
    await revealAgentBench(page);

    switch (feature) {
      case "ai-detector":
        return clickFirstVisible(aiDetectorLocators(page));
      case "plagiarism-checker":
        return clickFirstVisible(plagiarismLocators(page));
      case "ai-chat":
        return clickFirstVisible(agentButtonLocators(page, "AI Chat"));
      case "paraphraser":
      case "paraphrasing-tool":
        return clickFirstVisible(agentButtonLocators(page, "Paraphraser"));
      case "reader-reactions":
        return clickFirstVisible(agentButtonLocators(page, "Reader Reactions"));
      case "humanizer":
      case "ai-humanizer":
        return clickFirstVisible(agentButtonLocators(page, "Humanizer"));
      case "citation":
      case "citation-generator":
      case "citation-finder":
        return clickFirstVisible(agentButtonLocators(page, "Citation"));
      case "ai-rewriter":
        return clickFirstVisible(agentButtonLocators(page, "AI Rewriter"));
      case "ai-grader":
      case "essay-checker":
        return clickFirstVisible(agentButtonLocators(page, "AI Grader"));
      case "authorship":
        return clickFirstVisible(agentButtonLocators(page, "Authorship"));
      case "proofreader":
      case "grammar-checker":
      case "spell-checker":
      case "punctuation-checker":
      case "tone-detector":
      case "sentence-checker":
      case "passive-voice-checker":
      case "word-counter":
      case "character-counter":
      case "paragraph-counter":
      case "sentence-counter":
      case "ai-writing-tools":
        return true;
      case "resume-builder":
      case "style-guide":
      case "snippets":
      case "analytics":
      case "brand-tones":
        return false;
      default: {
        const exhaustiveCheck: never = feature;
        throw new Error(`Unsupported Grammarly feature: ${exhaustiveCheck}`);
      }
    }
  }

  private async applyFeatureInstruction(
    page: Page,
    feature: LocalGrammarlyFeatureId,
    instruction?: string,
  ): Promise<boolean> {
    if (!instruction?.trim()) {
      return false;
    }

    if (!interactiveAgentFeatures.has(feature)) {
      return false;
    }

    const textboxes = page.getByRole("textbox");
    const count = await textboxes.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const textbox = textboxes.nth(index);
      try {
        await textbox.click({ timeout: 2_000 });
        await page.keyboard.insertText(instruction.trim());
        await page.keyboard.press("Enter");
        return true;
      } catch {
        // Try the next textbox; Grammarly agent input placement changes.
      }
    }

    return false;
  }
}

export function shouldCopyProfileEntry(sourcePath: string): boolean {
  return !profileCopySkippedNames.has(path.basename(sourcePath));
}

export function prepareSessionProfile(
  config: AppConfig,
  options: LaunchSessionOptions = {},
): SessionProfilePlan {
  fs.mkdirSync(config.localBrowserProfileDir, { recursive: true });

  const sessionMode = config.localBrowserSessionMode ?? "isolated-copy";
  if (options.useSharedProfile || sessionMode === "shared-profile") {
    return {
      profileDir: config.localBrowserProfileDir,
      removeProfileOnClose: false,
    };
  }

  const profileRoot =
    config.localBrowserSessionProfileRoot ??
    path.join(path.dirname(config.localBrowserProfileDir), "session-profiles");
  fs.mkdirSync(profileRoot, { recursive: true });

  const profileDir = path.join(profileRoot, `local-${randomUUID()}`);
  fs.mkdirSync(profileDir, { recursive: true });
  copyBrowserProfile(config.localBrowserProfileDir, profileDir);

  return {
    profileDir,
    removeProfileOnClose: !config.localBrowserKeepSessionProfiles,
  };
}

export function copyBrowserProfile(sourceDir: string, targetDir: string): void {
  if (!fs.existsSync(sourceDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
    return;
  }

  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: shouldCopyProfileEntry,
  });
}

async function closeLocalSession(session: LocalSession): Promise<void> {
  try {
    await session.context.close();
  } finally {
    cleanupSessionProfile({
      profileDir: session.profileDir,
      removeProfileOnClose: session.removeProfileOnClose,
    });
  }
}

function cleanupSessionProfile(profilePlan: SessionProfilePlan): void {
  if (!profilePlan.removeProfileOnClose) {
    return;
  }

  fs.rmSync(profilePlan.profileDir, { recursive: true, force: true });
}

export async function openLocalGrammarlyLogin(
  config: AppConfig,
  waitSeconds: number,
): Promise<{
  profileDir: string;
  finalUrl: string;
  loggedIn: boolean;
}> {
  const provider = new LocalPlaywrightProvider(config);
  return provider.openLoginBrowser(waitSeconds * 1_000);
}

export async function listLocalGrammarlyFeatures(config: AppConfig) {
  const provider = new LocalPlaywrightProvider(config);
  return provider.listFeatures();
}

export async function runLocalGrammarlyFeature(
  config: AppConfig,
  feature: LocalGrammarlyFeatureId,
  text: string,
  instruction?: string,
) {
  const provider = new LocalPlaywrightProvider(config);
  return provider.runFeature(feature, text, instruction);
}

const featureMetadata: Record<
  LocalGrammarlyFeatureId,
  Omit<LocalGrammarlyFeatureSummary, "localDocsAvailable">
> = {
  proofreader: {
    id: "proofreader",
    label: "Proofreader",
    kind: "agent",
    notes:
      "Grammarly Docs default proofreading panel: writing quality, clarity, correctness, and impact suggestions.",
  },
  "grammar-checker": {
    id: "grammar-checker",
    label: "Grammar Checker",
    kind: "proofreader-capability",
    notes: "Covered by the Proofreader correctness suggestions.",
  },
  "spell-checker": {
    id: "spell-checker",
    label: "Spell Checker",
    kind: "proofreader-capability",
    notes: "Covered by the Proofreader correctness suggestions.",
  },
  "punctuation-checker": {
    id: "punctuation-checker",
    label: "Punctuation Checker",
    kind: "proofreader-capability",
    notes: "Covered by the Proofreader correctness suggestions.",
  },
  "tone-detector": {
    id: "tone-detector",
    label: "Tone Detector",
    kind: "proofreader-capability",
    notes:
      "Covered when Grammarly exposes tone or delivery guidance in the proofreader panel.",
  },
  "word-counter": {
    id: "word-counter",
    label: "Word Counter",
    kind: "metric",
    notes:
      "Computed locally and cross-checked against the Grammarly word-count footer when visible.",
  },
  "character-counter": {
    id: "character-counter",
    label: "Character Counter",
    kind: "metric",
    notes: "Computed locally from the editor text.",
  },
  "paragraph-counter": {
    id: "paragraph-counter",
    label: "Paragraph Counter",
    kind: "metric",
    notes: "Computed locally from the editor text.",
  },
  "sentence-counter": {
    id: "sentence-counter",
    label: "Sentence Counter",
    kind: "metric",
    notes: "Computed locally from the editor text.",
  },
  "sentence-checker": {
    id: "sentence-checker",
    label: "Sentence Checker",
    kind: "proofreader-capability",
    notes: "Covered by Proofreader sentence-level suggestions.",
  },
  "passive-voice-checker": {
    id: "passive-voice-checker",
    label: "Passive Voice Checker",
    kind: "proofreader-capability",
    notes:
      "Covered when Grammarly exposes passive-voice guidance in the proofreader panel.",
  },
  "essay-checker": {
    id: "essay-checker",
    label: "Essay Checker",
    kind: "agent",
    notes: "Mapped to Grammarly's AI Grader agent when exposed in Docs.",
  },
  "ai-writing-tools": {
    id: "ai-writing-tools",
    label: "AI Writing Tools",
    kind: "proofreader-capability",
    notes:
      "Umbrella public feature covered by Docs agents and proofreader capabilities.",
  },
  "ai-chat": {
    id: "ai-chat",
    label: "AI Chat",
    kind: "agent",
    notes: "Grammarly agent bench chat assistant.",
  },
  paraphraser: {
    id: "paraphraser",
    label: "Paraphraser",
    kind: "agent",
    notes: "Grammarly agent for rewriting while preserving meaning.",
  },
  "paraphrasing-tool": {
    id: "paraphrasing-tool",
    label: "Paraphrasing Tool",
    kind: "agent",
    notes: "Mapped to Grammarly's Paraphraser agent in Docs.",
  },
  "reader-reactions": {
    id: "reader-reactions",
    label: "Reader Reactions",
    kind: "agent",
    notes: "Grammarly agent for audience feedback.",
  },
  humanizer: {
    id: "humanizer",
    label: "Humanizer",
    kind: "agent",
    notes: "Grammarly agent for making AI-assisted writing sound more natural.",
  },
  "ai-humanizer": {
    id: "ai-humanizer",
    label: "AI Humanizer",
    kind: "agent",
    notes: "Mapped to Grammarly's Humanizer agent in Docs.",
  },
  citation: {
    id: "citation",
    label: "Citation",
    kind: "agent",
    notes: "Grammarly citation agent in Docs.",
  },
  "citation-generator": {
    id: "citation-generator",
    label: "Citation Generator",
    kind: "agent",
    notes: "Mapped to Grammarly's Citation agent when exposed in Docs.",
  },
  "citation-finder": {
    id: "citation-finder",
    label: "Citation Finder",
    kind: "agent",
    notes: "Mapped to Grammarly's Citation agent when exposed in Docs.",
  },
  "ai-detector": {
    id: "ai-detector",
    label: "AI Detector",
    kind: "agent",
    notes: "Reads Grammarly's visible AI detection result.",
  },
  "ai-rewriter": {
    id: "ai-rewriter",
    label: "AI Rewriter",
    kind: "agent",
    notes:
      "Grammarly agent for replacing phrases that may appear AI-generated.",
  },
  "plagiarism-checker": {
    id: "plagiarism-checker",
    label: "Plagiarism Checker",
    kind: "agent",
    notes: "Reads Grammarly's visible plagiarism/originality result.",
  },
  "ai-grader": {
    id: "ai-grader",
    label: "AI Grader",
    kind: "agent",
    notes: "Grammarly grading agent when available in the account.",
  },
  authorship: {
    id: "authorship",
    label: "Authorship",
    kind: "agent",
    notes: "Grammarly authorship agent when available in the account.",
  },
  "resume-builder": {
    id: "resume-builder",
    label: "Resume Builder",
    kind: "agent",
    notes:
      "Public Grammarly tool; not exposed as a local Docs agent in every account.",
  },
  "style-guide": {
    id: "style-guide",
    label: "Style Guide",
    kind: "agent",
    notes:
      "Team/enterprise feature; not exposed as a local Docs agent in this UI.",
  },
  snippets: {
    id: "snippets",
    label: "Snippets",
    kind: "agent",
    notes:
      "Team/enterprise feature; not exposed as a local Docs agent in this UI.",
  },
  analytics: {
    id: "analytics",
    label: "Analytics",
    kind: "agent",
    notes: "Team/admin feature; not exposed as a local Docs agent in this UI.",
  },
  "brand-tones": {
    id: "brand-tones",
    label: "Brand Tones",
    kind: "agent",
    notes:
      "Team/enterprise feature; not exposed as a local Docs agent in this UI.",
  },
};

const proofreaderFeatures = new Set<LocalGrammarlyFeatureId>([
  "proofreader",
  "grammar-checker",
  "spell-checker",
  "punctuation-checker",
  "tone-detector",
  "sentence-checker",
  "passive-voice-checker",
  "ai-writing-tools",
]);

const metricFeatures = new Set<LocalGrammarlyFeatureId>([
  "word-counter",
  "character-counter",
  "paragraph-counter",
  "sentence-counter",
]);

const localAvailabilityLabels: Partial<
  Record<LocalGrammarlyFeatureId, string>
> = {
  "paraphrasing-tool": "Paraphraser",
  "ai-humanizer": "Humanizer",
  "citation-generator": "Citation",
  "citation-finder": "Citation",
  "essay-checker": "AI Grader",
};

const interactiveAgentFeatures = new Set<LocalGrammarlyFeatureId>([
  "ai-chat",
  "paraphraser",
  "paraphrasing-tool",
  "reader-reactions",
  "humanizer",
  "ai-humanizer",
  "citation",
  "citation-generator",
  "citation-finder",
  "ai-rewriter",
  "ai-grader",
  "essay-checker",
]);

const rewriteProducingFeatures = new Set<LocalGrammarlyFeatureId>([
  "paraphraser",
  "paraphrasing-tool",
  "humanizer",
  "ai-humanizer",
  "ai-rewriter",
]);

async function ensurePage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  return existing ?? context.newPage();
}

function buildFeatureSummaries(
  visibleAgentLabels: Set<string>,
): LocalGrammarlyFeatureSummary[] {
  return LOCAL_GRAMMARLY_FEATURES.map((id) => {
    const metadata = featureMetadata[id];
    const expectedLabel = (
      localAvailabilityLabels[id] ?? metadata.label
    ).toLowerCase();
    const localDocsAvailable =
      proofreaderFeatures.has(id) ||
      metricFeatures.has(id) ||
      Array.from(visibleAgentLabels).some(
        (label) => label.toLowerCase() === expectedLabel,
      );
    return {
      ...metadata,
      localDocsAvailable,
    };
  });
}

async function collectVisibleAgentLabels(page: Page): Promise<Set<string>> {
  const labels = await page.evaluate(() => {
    const results = new Set<string>();
    for (const element of Array.from(
      document.querySelectorAll('button,[role="button"]'),
    )) {
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) {
        continue;
      }

      const label =
        element.getAttribute("aria-label") ||
        (element.textContent ?? "").replace(/\s+/g, " ").trim();
      if (
        /^(AI Chat|Paraphraser|Reader Reactions|Humanizer|Citation|AI Detector|AI Rewriter|Plagiarism Checker|AI Grader|Authorship)$/i.test(
          label,
        ) ||
        /^Open (AI Chat|Paraphraser|Reader Reactions|Humanizer|Citation|AI Detector|AI Rewriter|Plagiarism Checker|AI Grader|Authorship) agent$/i.test(
          label,
        )
      ) {
        results.add(label.replace(/^Open /i, "").replace(/ agent$/i, ""));
      }
    }
    return Array.from(results).sort();
  });

  return new Set(labels.map(canonicalFeatureLabel));
}

function agentButtonLocators(page: Page, label: string): Locator[] {
  const escapedLabel = escapeRegExp(label);
  return [
    page.getByRole("button", { name: new RegExp(`^${escapedLabel}$`, "i") }),
    page.getByRole("button", {
      name: new RegExp(`^Open ${escapedLabel} agent$`, "i"),
    }),
    page.locator(`button[aria-label="${label}"]`),
    page.locator(`[role="button"][aria-label="Open ${label} agent"]`),
    page.getByText(new RegExp(`^${escapedLabel}$`, "i")),
  ];
}

function aiDetectorLocators(page: Page): Locator[] {
  return [
    page.getByRole("button", { name: /open ai detector agent/i }),
    page.getByRole("button", { name: /^ai detector$/i }),
    page.locator('[role="button"][aria-label*="AI detector" i]'),
    page.locator('button[aria-label*="AI Detector" i]'),
    page.getByText(/check for ai text|ai detector|ai-generated/i),
  ];
}

function plagiarismLocators(page: Page): Locator[] {
  return [
    page.getByRole("button", { name: /^plagiarism checker$/i }),
    page.locator('[role="button"][aria-label*="Plagiarism" i]'),
    page.locator('button[aria-label*="Plagiarism" i]'),
    page.getByText(/plagiarism|originality|copied text/i),
  ];
}

async function revealAgentBench(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      for (const element of Array.from(document.querySelectorAll("*"))) {
        const rect = element.getBoundingClientRect();
        if (rect.width > 20 && rect.height > 80) {
          element.scrollTop = element.scrollHeight;
        }
      }
    })
    .catch(() => undefined);
  await page.waitForTimeout(500);
}

function canonicalFeatureLabel(label: string): string {
  const normalized = label.trim().toLowerCase();
  const labels = [
    "AI Chat",
    "Paraphraser",
    "Reader Reactions",
    "Humanizer",
    "Citation",
    "AI Detector",
    "AI Rewriter",
    "Plagiarism Checker",
    "AI Grader",
    "Authorship",
  ];
  return (
    labels.find((candidate) => candidate.toLowerCase() === normalized) ?? label
  );
}

function featureWaitMs(feature: LocalGrammarlyFeatureId): number {
  switch (feature) {
    case "ai-detector":
      return 8_000;
    case "plagiarism-checker":
      return 10_000;
    case "ai-chat":
    case "paraphraser":
    case "reader-reactions":
    case "humanizer":
    case "ai-humanizer":
    case "citation":
    case "ai-rewriter":
    case "ai-grader":
    case "authorship":
      return 8_000;
    default:
      return 4_000;
  }
}

async function clickFirstVisible(locators: Locator[]): Promise<boolean> {
  for (const locator of locators) {
    try {
      await locator.first().click({ timeout: 5_000 });
      return true;
    } catch {
      // Try the next locator.
    }
  }

  return false;
}

export async function tryAcceptRewriteSuggestion(page: Page): Promise<boolean> {
  return clickFirstVisible([
    page.getByRole("button", { name: /^accept$/i }),
    page.locator('button[aria-label="Accept"]'),
    page.locator('[role="button"][aria-label="Accept"]'),
    page.getByText(/^Accept$/i),
  ]);
}

type RewriteAcceptanceStatus =
  | "accepted"
  | "chat-extracted"
  | "rejected-unrelated"
  | "not-found"
  | "not-applicable";

export function isRelatedRewrite(original: string, candidate: string): boolean {
  const originalText = original.trim();
  const candidateText = candidate.trim();
  if (!originalText || !candidateText || candidateText === originalText) {
    return false;
  }

  const originalTokens = meaningfulTokens(originalText);
  const candidateTokens = meaningfulTokens(candidateText);
  if (originalTokens.size < 4 || candidateTokens.size < 4) {
    return true;
  }

  let overlap = 0;
  for (const token of originalTokens) {
    if (candidateTokens.has(token)) {
      overlap += 1;
      if (token.length >= 8) {
        return true;
      }
    }
  }

  return (
    overlap >= 2 ||
    overlap / Math.min(originalTokens.size, candidateTokens.size) >= 0.15
  );
}

async function tryAcceptRelevantRewriteSuggestion(
  page: Page,
  originalText: string,
): Promise<RewriteAcceptanceStatus> {
  const accepted = await tryAcceptRewriteSuggestion(page);
  if (!accepted) {
    return "not-found";
  }

  await page.waitForTimeout(1_000);
  const candidateText = await getDocumentText(page, "");
  if (isRelatedRewrite(originalText, candidateText)) {
    return "accepted";
  }

  await page.keyboard.press("ControlOrMeta+Z").catch(() => undefined);
  await page.waitForTimeout(500);
  return "rejected-unrelated";
}

const rewriteResultMarker = "REWRITE_RESULT:";

export function buildRewriteAgentPrompt(
  feature: LocalGrammarlyFeatureId,
  text: string,
  instruction?: string,
): string {
  const label = featureMetadata[feature]?.label ?? feature;
  const userInstruction = instruction?.trim()
    ? `User instruction: ${instruction.trim()}\n\n`
    : "";

  return [
    `Use ${label} on the text below.`,
    userInstruction,
    "Return only the final rewritten text.",
    `Prefix the answer exactly with ${rewriteResultMarker}`,
    "",
    "Text:",
    '"""',
    text,
    '"""',
  ].join("\n");
}

export function extractAgentRewriteText(
  panelText: string,
  originalText: string,
  prompt?: string,
): string | null {
  const normalized = normalizeText(panelText);
  const markerIndex = normalized.lastIndexOf(rewriteResultMarker);

  let candidate =
    markerIndex >= 0
      ? normalized.slice(markerIndex + rewriteResultMarker.length)
      : extractTextAfterPrompt(normalized, prompt);

  candidate = cleanAgentRewriteCandidate(candidate);
  if (!candidate) {
    return null;
  }

  if (!isRelatedRewrite(originalText, candidate)) {
    return null;
  }

  return candidate;
}

async function waitForAgentRewrite({
  page,
  prompt,
  originalText,
  timeoutMs,
}: {
  page: Page;
  prompt: string;
  originalText: string;
  timeoutMs: number;
}): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let lastCandidate: string | null = null;
  let stableCount = 0;

  while (Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    const bodyText = await getBodyText(page);
    const candidate = extractAgentRewriteText(bodyText, originalText, prompt);

    if (candidate && candidate === lastCandidate) {
      stableCount += 1;
      if (stableCount >= 2) {
        return candidate;
      }
    } else {
      lastCandidate = candidate;
      stableCount = candidate ? 1 : 0;
    }
  }

  return lastCandidate;
}

async function getBodyText(page: Page): Promise<string> {
  try {
    return await page.locator("body").innerText({ timeout: 8_000 });
  } catch {
    return "";
  }
}

async function getDocumentText(page: Page, fallback: string): Promise<string> {
  try {
    const text = await page
      .locator('[contenteditable="true"]')
      .first()
      .innerText({ timeout: 5_000 });
    return text.trim() || fallback;
  } catch {
    return fallback;
  }
}

function buildFeatureResult({
  feature,
  available,
  loggedIn,
  finalUrl,
  bodyText,
  documentText,
  rewrittenText,
  notes,
}: {
  feature: LocalGrammarlyFeatureId;
  available: boolean;
  loggedIn: boolean;
  finalUrl: string;
  bodyText: string;
  documentText: string;
  rewrittenText?: string | null;
  notes: string;
}): LocalGrammarlyFeatureResult {
  return {
    feature,
    available,
    loggedIn,
    finalUrl,
    panelText: summarizeText(bodyText, 2_000),
    documentText,
    rewrittenText: rewrittenText ?? null,
    scores: {
      writingQuality: extractWritingQuality(bodyText),
      aiDetectionPercent: extractAiPercent(bodyText),
      plagiarismPercent: extractPlagiarismPercent(bodyText),
    },
    metrics: computeTextMetrics(documentText, bodyText),
    notes,
  };
}

function buildRunFeatureNotes({
  opened,
  rewriteStatus,
  rewriteProducing,
}: {
  opened: boolean;
  rewriteStatus: RewriteAcceptanceStatus;
  rewriteProducing: boolean;
}): string {
  if (!opened) {
    return "The requested feature did not expose a clickable local Docs control; returned the proofreader/editor state instead.";
  }

  if (rewriteStatus === "accepted") {
    return "Opened the requested Grammarly feature, accepted the visible rewrite suggestion, and extracted the updated editor text.";
  }

  if (rewriteStatus === "chat-extracted") {
    return "Opened the requested Grammarly chat agent, waited for a stable assistant rewrite, and returned it in rewrittenText.";
  }

  if (rewriteStatus === "rejected-unrelated") {
    return "Opened the requested Grammarly rewrite feature, but rejected the visible rewrite suggestion because it did not appear related to the current input.";
  }

  if (rewriteProducing) {
    return "Opened the requested Grammarly rewrite feature, but no visible Accept control appeared; returned the visible panel and editor state.";
  }

  return "Opened the requested Grammarly feature in the local Docs UI and extracted visible output.";
}

function extractWritingQuality(text: string): number | null {
  return extractPercentNear(text, [
    /writing quality[^\d]{0,40}(\d{1,3})\s*\/\s*100/i,
  ]);
}

const commonRewriteStopWords = new Set([
  "about",
  "across",
  "after",
  "also",
  "because",
  "been",
  "being",
  "from",
  "have",
  "into",
  "more",
  "that",
  "their",
  "there",
  "this",
  "through",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would",
]);

function meaningfulTokens(text: string): Set<string> {
  return new Set(
    Array.from(text.toLowerCase().matchAll(/[a-z0-9][a-z0-9'-]{3,}/g))
      .map((match) => match[0].replace(/^'+|'+$/g, ""))
      .filter(
        (token) => token.length >= 4 && !commonRewriteStopWords.has(token),
      ),
  );
}

function extractTextAfterPrompt(text: string, prompt?: string): string {
  if (!prompt?.trim()) {
    return "";
  }

  const normalizedPrompt = normalizeText(prompt);
  const promptIndex = text.lastIndexOf(normalizedPrompt);
  if (promptIndex < 0) {
    return "";
  }

  return text.slice(promptIndex + normalizedPrompt.length);
}

function cleanAgentRewriteCandidate(candidate: string): string {
  let cleaned = normalizeText(candidate)
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/\s+\b[A-Z]\s+\d{1,6}\s+words?$/i, "")
    .replace(/\s+\d{1,6}\s+words?$/i, "")
    .trim();

  cleaned = cleaned.replace(
    /^Hi Michael,?\s+I can help you create the best version of your writing\.?\s*/i,
    "",
  );
  cleaned = cleaned.replace(
    /^Take action without waiting for approval\.?\s+Propose edits or content right away\.?\s*/i,
    "",
  );

  const tailMarkers = [
    "Grammarly Proofreader",
    "Writing quality",
    "Ready when you are",
    "Suggestions",
    "Accept",
    "Dismiss",
    "AI Chat",
  ];
  for (const marker of tailMarkers) {
    const index = cleaned.search(
      new RegExp(`\\b${escapeRegExp(marker)}\\b`, "i"),
    );
    if (index > 20) {
      cleaned = cleaned.slice(0, index).trim();
    }
  }

  if (isAgentBoilerplate(cleaned)) {
    return "";
  }

  return cleaned;
}

function isAgentBoilerplate(text: string): boolean {
  if (text.length < 20) {
    return true;
  }

  return /^(hi michael|i can help you create the best version|take action without waiting|ready when you are|add \d+ words?)/i.test(
    text,
  );
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractAiPercent(text: string): number | null {
  return extractPercentNear(text, [
    /(\d{1,3})\s*%\s*(?:ai|generated|ai-generated|ai written|ai-written)/i,
    /(?:ai|generated|ai-generated|ai written|ai-written)[^\d]{0,80}(\d{1,3})\s*%/i,
  ]);
}

function extractPlagiarismPercent(text: string): number | null {
  if (
    /no copied text detected|no plagiarism found|didn't match anything/i.test(
      text,
    )
  ) {
    return 0;
  }

  const originality = extractPercentNear(text, [
    /(\d{1,3})\s*%\s*original/i,
    /originality[^\d]{0,80}(\d{1,3})\s*%/i,
  ]);
  if (originality !== null) {
    return Math.max(0, Math.min(100, 100 - originality));
  }

  return extractPercentNear(text, [
    /no copied text detected[^\d]{0,80}(\d{1,3})\s*%/i,
    /(\d{1,3})\s*%\s*(?:plagiarism|plagiarized|similarity|matched)/i,
    /(?:plagiarism|plagiarized|similarity|matched|copied text)[^\d]{0,80}(\d{1,3})\s*%/i,
  ]);
}

function extractPercentNear(text: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const raw = match?.[1];
    if (!raw) {
      continue;
    }

    const value = Number.parseInt(raw, 10);
    if (Number.isInteger(value) && value >= 0 && value <= 100) {
      return value;
    }
  }

  return null;
}

function computeTextMetrics(text: string, bodyText: string): TextMetrics {
  const normalized = text.trim();
  const words = normalized.match(/\b[\p{L}\p{N}'-]+\b/gu)?.length ?? 0;
  const characters = normalized.length;
  const charactersNoSpaces = normalized.replace(/\s/g, "").length;
  const sentences =
    normalized.match(/[^.!?]+[.!?]+(?:\s|$)/g)?.length ?? (normalized ? 1 : 0);
  const paragraphs = normalized
    ? normalized.split(/\n{2,}/).filter((paragraph) => paragraph.trim()).length
    : 0;
  const grammarlyWordCountMatch = /(\d{1,6})\s+words?\b/i.exec(bodyText);

  return {
    words,
    characters,
    charactersNoSpaces,
    sentences,
    paragraphs,
    grammarlyWordCount: grammarlyWordCountMatch?.[1]
      ? Number.parseInt(grammarlyWordCountMatch[1], 10)
      : null,
  };
}

function buildExtractionNotes(
  bodyText: string,
  aiDetectionPercent: number | null,
  plagiarismPercent: number | null,
): string {
  const foundScores =
    aiDetectionPercent !== null || plagiarismPercent !== null
      ? "Extracted visible Grammarly score text from the local browser."
      : "No explicit AI detection or plagiarism percentage was visible in Grammarly's local browser UI.";

  return `${foundScores} Visible page summary: ${summarizeText(bodyText)}`;
}

function summarizeText(text: string, maxLength = 700): string {
  return text.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
