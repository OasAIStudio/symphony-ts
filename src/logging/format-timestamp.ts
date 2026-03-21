/**
 * Format a Date as an ISO-like string in US Eastern time.
 * Output: "2026-03-21T14:45:00.000-04:00" (or -05:00 in EST)
 */
export function formatEasternTimestamp(date: Date = new Date()): string {
  // Get the date/time components in Eastern time
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || "";

  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");
  const second = get("second");

  // Get milliseconds (not available from formatToParts)
  const ms = String(date.getMilliseconds()).padStart(3, "0");

  // Get the timezone offset
  const offset = getEasternOffset(date);

  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${ms}${offset}`;
}

/**
 * Get the UTC offset for US Eastern time at the given date.
 * Returns format like "-04:00" (EDT) or "-05:00" (EST)
 */
function getEasternOffset(date: Date): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "shortOffset",
  });

  const parts = formatter.formatToParts(date);
  const offsetPart = parts.find((p) => p.type === "timeZoneName");

  // offsetPart.value is like "GMT-4" or "GMT-5"
  const match = offsetPart?.value?.match(/GMT([+-]?\d+)/);
  if (!match?.[1]) {
    // Fallback to EST if we can't parse
    return "-05:00";
  }

  const hours = Number.parseInt(match[1], 10);
  const sign = hours <= 0 ? "-" : "+";
  const absHours = Math.abs(hours);

  return `${sign}${String(absHours).padStart(2, "0")}:00`;
}
