import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRewriteAgentPrompt,
  copyBrowserProfile,
  extractAgentRewriteText,
  isRelatedRewrite,
  prepareSessionProfile,
  shouldCopyProfileEntry,
  tryAcceptRewriteSuggestion,
} from "../../../src/browser/localPlaywrightProvider";
import type { AppConfig } from "../../../src/config";

const baseConfig: AppConfig = {
  ignoreSystemEnv: false,
  browserProvider: "local-playwright",
  browserUseApiKey: undefined,
  browserUseProfileId: undefined,
  browserbaseApiKey: undefined,
  browserbaseProjectId: undefined,
  browserbaseSessionId: undefined,
  browserbaseContextId: undefined,
  browserbaseAdvancedStealth: false,
  stagehandModel: "gemini-2.5-flash",
  stagehandCacheDir: undefined,
  stagehandLlmProvider: undefined,
  rewriteLlmProvider: undefined,
  claudeCodeExecutable: undefined,
  claudeModel: "auto",
  openaiModel: "gpt-4o",
  googleModel: "gemini-2.5-flash",
  anthropicModel: "claude-sonnet-4-20250514",
  claudeApiKey: undefined,
  openaiApiKey: undefined,
  googleApiKey: undefined,
  anthropicApiKey: undefined,
  llmRequestTimeoutMs: 120000,
  connectTimeoutMs: 30000,
  logLevel: "error",
  browserUseDefaultTimeoutMs: 300000,
  defaultMaxAiPercent: 10,
  defaultMaxPlagiarismPercent: 5,
  defaultMaxIterations: 5,
  localBrowserProfileDir: "",
  localBrowserHeadless: true,
  localBrowserChannel: "chrome",
  localBrowserExecutable: undefined,
  localBrowserSessionMode: "isolated-copy",
  localBrowserSessionProfileRoot: "",
  localBrowserKeepSessionProfiles: false,
};

describe("local Playwright profile isolation", () => {
  let tempDir: string;
  let profileDir: string;
  let sessionRoot: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "grammarly-local-"));
    profileDir = path.join(tempDir, "base-profile");
    sessionRoot = path.join(tempDir, "sessions");
    fs.mkdirSync(path.join(profileDir, "Default", "Cache"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(profileDir, "Default", "Code Cache"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(profileDir, "Default", "Cookies"), "auth");
    fs.writeFileSync(path.join(profileDir, "SingletonLock"), "locked");
    fs.writeFileSync(path.join(profileDir, "Default", "Cache", "blob"), "x");
    fs.writeFileSync(
      path.join(profileDir, "Default", "Code Cache", "code"),
      "x",
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("skips Chromium lock and cache entries when cloning a profile", () => {
    expect(shouldCopyProfileEntry(path.join(profileDir, "SingletonLock"))).toBe(
      false,
    );
    expect(
      shouldCopyProfileEntry(path.join(profileDir, "Default", "Cache")),
    ).toBe(false);
    expect(
      shouldCopyProfileEntry(path.join(profileDir, "Default", "Cookies")),
    ).toBe(true);
  });

  it("copies auth data into an isolated per-session profile", () => {
    const targetDir = path.join(tempDir, "target-profile");

    copyBrowserProfile(profileDir, targetDir);

    expect(fs.existsSync(path.join(targetDir, "Default", "Cookies"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(targetDir, "SingletonLock"))).toBe(false);
    expect(fs.existsSync(path.join(targetDir, "Default", "Cache"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(targetDir, "Default", "Code Cache"))).toBe(
      false,
    );
  });

  it("prepares different isolated profile directories for simultaneous sessions", () => {
    const config: AppConfig = {
      ...baseConfig,
      localBrowserProfileDir: profileDir,
      localBrowserSessionProfileRoot: sessionRoot,
    };

    const first = prepareSessionProfile(config);
    const second = prepareSessionProfile(config);

    expect(first.profileDir).not.toBe(second.profileDir);
    expect(first.profileDir.startsWith(sessionRoot)).toBe(true);
    expect(second.profileDir.startsWith(sessionRoot)).toBe(true);
    expect(first.removeProfileOnClose).toBe(true);
    expect(second.removeProfileOnClose).toBe(true);
  });

  it("uses the shared base profile for login sessions", () => {
    const config: AppConfig = {
      ...baseConfig,
      localBrowserProfileDir: profileDir,
      localBrowserSessionProfileRoot: sessionRoot,
    };

    const plan = prepareSessionProfile(config, { useSharedProfile: true });

    expect(plan.profileDir).toBe(profileDir);
    expect(plan.removeProfileOnClose).toBe(false);
  });
});

describe("rewrite suggestion handling", () => {
  function locatorThat(click: () => Promise<void>) {
    return {
      first: () => ({
        click,
      }),
    };
  }

  it("accepts a visible Grammarly rewrite suggestion", async () => {
    const acceptClick = vi.fn().mockResolvedValue(undefined);
    const page = {
      getByRole: vi.fn(() => locatorThat(acceptClick)),
      locator: vi.fn(() => locatorThat(vi.fn())),
      getByText: vi.fn(() => locatorThat(vi.fn())),
    } as unknown as Page;

    await expect(tryAcceptRewriteSuggestion(page)).resolves.toBe(true);
    expect(acceptClick).toHaveBeenCalledWith({ timeout: 5_000 });
  });

  it("falls back across selectors when the first Accept locator is not clickable", async () => {
    const missingClick = vi.fn().mockRejectedValue(new Error("not visible"));
    const acceptClick = vi.fn().mockResolvedValue(undefined);
    const page = {
      getByRole: vi.fn(() => locatorThat(missingClick)),
      locator: vi.fn(() => locatorThat(acceptClick)),
      getByText: vi.fn(() => locatorThat(vi.fn())),
    } as unknown as Page;

    await expect(tryAcceptRewriteSuggestion(page)).resolves.toBe(true);
    expect(missingClick).toHaveBeenCalledWith({ timeout: 5_000 });
    expect(acceptClick).toHaveBeenCalledWith({ timeout: 5_000 });
  });

  it("treats a rewrite about the same input as related", () => {
    expect(
      isRelatedRewrite(
        "The sprint planning note is overly polished and sounds generated. It says the team will leverage a comprehensive framework to unlock productivity.",
        "The sprint planning note sounds too formal and artificial. It says the team will use a clear framework to improve productivity.",
      ),
    ).toBe(true);
  });

  it("treats a marked rewrite with changed wording as related", () => {
    expect(
      isRelatedRewrite(
        "ZXHUM1780001893061: This comprehensive initiative leverages a multifaceted framework to streamline cross-functional collaboration and maximize stakeholder alignment.",
        "ZXHUM1780001893061: This initiative uses a flexible approach to make teamwork easier and ensure everyone involved is on the same page.",
      ),
    ).toBe(true);
  });

  it("rejects cached rewrite text from an unrelated document", () => {
    expect(
      isRelatedRewrite(
        "The sprint planning note is overly polished and sounds generated.",
        "This home offers 6,000 square feet, five bedrooms, a guest suite, and a landscaped courtyard.",
      ),
    ).toBe(false);
  });

  it("builds a marked rewrite prompt for chat agents", () => {
    const prompt = buildRewriteAgentPrompt(
      "humanizer",
      "This paragraph sounds robotic and overly polished.",
      "Make it sound natural.",
    );

    expect(prompt).toContain("Use Humanizer");
    expect(prompt).toContain("Make it sound natural.");
    expect(prompt).toContain("REWRITE_RESULT:");
    expect(prompt).toContain("This paragraph sounds robotic");
  });

  it("extracts a marked stable chat rewrite without panel chrome", () => {
    const original =
      "The sprint planning note is overly polished and sounds generated.";
    const panelText = [
      "AI Chat",
      "REWRITE_RESULT: The sprint planning note sounds too formal and artificial.",
      "Grammarly Proofreader",
      "Writing quality 100 / 100",
    ].join("\n");

    expect(extractAgentRewriteText(panelText, original)).toBe(
      "The sprint planning note sounds too formal and artificial.",
    );
  });

  it("strips Grammarly word-count badges from marked chat rewrites", () => {
    expect(
      extractAgentRewriteText(
        "REWRITE_RESULT: ZXHUM1780001893061: This initiative uses a flexible approach to make teamwork easier. M 21 words",
        "ZXHUM1780001893061: This comprehensive initiative leverages a multifaceted framework.",
      ),
    ).toBe(
      "ZXHUM1780001893061: This initiative uses a flexible approach to make teamwork easier.",
    );
  });

  it("rejects chat onboarding boilerplate as a rewrite", () => {
    expect(
      extractAgentRewriteText(
        "AI Chat Hi Michael, I can help you create the best version of your writing. Take action without waiting for approval.",
        "The sprint planning note is overly polished and sounds generated.",
      ),
    ).toBeNull();
  });
});
