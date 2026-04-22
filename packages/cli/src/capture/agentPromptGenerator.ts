/**
 * Generate AGENTS.md and CLAUDE.md for captured website projects.
 *
 * Writes the same content to both filenames so any AI agent auto-discovers it:
 *   - AGENTS.md  — universal convention (Cursor, Codex, Gemini CLI, Windsurf, Aider, Jules)
 *   - CLAUDE.md  — Claude Code convention
 *
 * This file generates a DATA INVENTORY that tells the AI agent what files
 * exist and what they contain. The actual workflow lives in the
 * website-to-hyperframes skill — this file points agents there.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DesignTokens } from "./types.js";
import type { AnimationCatalog } from "./animationCataloger.js";
import type { CatalogedAsset } from "./assetCataloger.js";

export function generateAgentPrompt(
  outputDir: string,
  url: string,
  tokens: DesignTokens,
  _animations: AnimationCatalog | undefined, // reserved for future animation summary
  hasScreenshot: boolean,
  hasLottie?: boolean,
  hasShaders?: boolean,
  _catalogedAssets?: CatalogedAsset[], // reserved for future asset inventory
  detectedLibraries?: string[],
): void {
  const prompt = buildPrompt(url, tokens, hasScreenshot, hasLottie, hasShaders, detectedLibraries);
  writeFileSync(join(outputDir, "AGENTS.md"), prompt, "utf-8");
  writeFileSync(join(outputDir, "CLAUDE.md"), prompt, "utf-8");
  writeFileSync(join(outputDir, ".cursorrules"), prompt, "utf-8");
}

function buildPrompt(
  url: string,
  tokens: DesignTokens,
  hasScreenshot: boolean,
  hasLottie?: boolean,
  hasShaders?: boolean,
  detectedLibraries?: string[],
): string {
  const title = tokens.title || new URL(url).hostname.replace(/^www\./, "");

  const colorSummary = tokens.colors.slice(0, 10).join(", ");
  const fontSummary =
    tokens.fonts
      .map(
        (f) =>
          f.family +
          (f.variable && f.weightRange
            ? ` (${f.weightRange[0]}-${f.weightRange[1]} variable)`
            : f.weights.length > 0
              ? ` (${f.weights.join(",")})`
              : ""),
      )
      .join(", ") || "none detected";

  // Build the data inventory table rows
  const tableRows: string[] = [];
  if (hasScreenshot) {
    tableRows.push(
      "| `screenshots/scroll-*.png` | Viewport screenshots of the full page. Start with `scroll-000.png` (hero). |",
    );
  }
  tableRows.push(
    "| `extracted/asset-descriptions.md` | One-line description of every downloaded asset. **Read this first.** |",
  );
  tableRows.push(
    `| \`extracted/tokens.json\` | Design tokens: ${tokens.colors.length} colors, ${tokens.fonts.length} fonts, ${tokens.headings?.length ?? 0} headings, ${tokens.ctas?.length ?? 0} CTAs |`,
  );
  tableRows.push(
    "| `extracted/visible-text.txt` | Page text in DOM order, prefixed with HTML tag (`[h1]`, `[p]`, `[a]`). Use as context — rephrase freely. |",
  );
  if (hasLottie) {
    tableRows.push(
      "| `extracted/lottie-manifest.json` | Lottie animations with previews at `assets/lottie/previews/`. |",
    );
  }
  if (hasShaders) {
    tableRows.push("| `extracted/shaders.json` | WebGL shader source (GLSL). |");
  }
  if (detectedLibraries && detectedLibraries.length > 0) {
    tableRows.push(
      `| \`extracted/detected-libraries.json\` | Libraries: ${detectedLibraries.join(", ")} |`,
    );
  }
  tableRows.push("| `assets/` | Downloaded images, SVGs, and font files. |");

  // Brand summary — just the essentials
  const brandLines: string[] = [];
  brandLines.push(`- **Colors**: ${colorSummary || "see tokens.json"}`);
  brandLines.push(`- **Fonts**: ${fontSummary}`);
  if (detectedLibraries && detectedLibraries.length > 0) {
    brandLines.push(`- **Built with**: ${detectedLibraries.join(", ")}`);
  }

  return `# ${title}

Source: ${url}

To create a video from this capture, use the \`website-to-hyperframes\` skill.

## What's in This Capture

| File | Contents |
|------|----------|
${tableRows.join("\n")}

## Brand Summary

${brandLines.join("\n")}
`;
}
