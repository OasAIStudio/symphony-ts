/**
 * Markdown-to-mrkdwn converter for non-streamed Slack content.
 *
 * Streamed content uses `markdown_text` which accepts standard markdown natively.
 * This converter is only used for non-streamed content such as error messages,
 * slash command responses, and unmapped channel warnings posted via `say()`.
 *
 * Uses a protected-region pattern: fenced code blocks and inline code are
 * extracted as placeholders before conversion, then restored afterward.
 */

/** Placeholder prefix used to protect code regions during conversion. */
const PLACEHOLDER_PREFIX = "\x00CODE_REGION_";

/** Placeholder prefix for bold regions to prevent italic conversion. */
const BOLD_PREFIX = "\x00BOLD_REGION_";

/**
 * Convert standard Markdown to Slack mrkdwn format.
 *
 * Protected regions (fenced code blocks and inline code) are preserved as-is.
 * Converts: links, headers, bold, italic, and strikethrough.
 */
export function markdownToMrkdwn(markdown: string): string {
  const regions: string[] = [];
  const boldRegions: string[] = [];

  // Step 1: Extract protected regions (fenced code blocks first, then inline code)
  let text = markdown;

  // Fenced code blocks: ```...```
  text = text.replace(/```[\s\S]*?```/g, (match) => {
    const index = regions.length;
    regions.push(match);
    return `${PLACEHOLDER_PREFIX}${index}\x00`;
  });

  // Inline code: `...`
  text = text.replace(/`[^`]+`/g, (match) => {
    const index = regions.length;
    regions.push(match);
    return `${PLACEHOLDER_PREFIX}${index}\x00`;
  });

  // Step 2: Convert markdown syntax to mrkdwn

  // Links: [text](url) → <url|text>
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Headers: ## Header → *Header* (protect from italic conversion)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (_match, content: string) => {
    const index = boldRegions.length;
    boldRegions.push(`*${content}*`);
    return `${BOLD_PREFIX}${index}\x00`;
  });

  // Bold: **text** → *text* (protect from italic conversion)
  text = text.replace(/\*\*(.+?)\*\*/g, (_match, content: string) => {
    const index = boldRegions.length;
    boldRegions.push(`*${content}*`);
    return `${BOLD_PREFIX}${index}\x00`;
  });

  // Italic: *text* → _text_
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "_$1_");

  // Strikethrough: ~~text~~ → ~text~
  text = text.replace(/~~(.+?)~~/g, "~$1~");

  // Step 3: Restore bold regions
  for (let i = boldRegions.length - 1; i >= 0; i--) {
    text = text.replace(`${BOLD_PREFIX}${i}\x00`, boldRegions[i] ?? "");
  }

  // Step 4: Restore code regions
  for (let i = regions.length - 1; i >= 0; i--) {
    text = text.replace(`${PLACEHOLDER_PREFIX}${i}\x00`, regions[i] ?? "");
  }

  return text;
}
