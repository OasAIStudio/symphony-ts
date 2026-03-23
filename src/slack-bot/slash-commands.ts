/**
 * Slash command parsing for the Slack bot.
 *
 * Parses `/project set <path>` from message text and returns
 * structured command objects. Unknown commands return `null`.
 */

/** A parsed `/project set` command. */
export interface ProjectSetCommand {
  type: "project-set";
  path: string;
}

export type SlashCommand = ProjectSetCommand;

/**
 * Parse a slash command from message text.
 *
 * Currently supports:
 * - `/project set <path>` — set the channel-to-project mapping
 *
 * Returns `null` if the text is not a recognized slash command.
 */
export function parseSlashCommand(text: string): SlashCommand | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/project\s+set\s+(.+)$/);
  if (match?.[1]) {
    return { type: "project-set", path: match[1].trim() };
  }
  return null;
}
