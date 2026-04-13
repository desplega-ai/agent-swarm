import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind CSS classes with clsx
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Parse a date string as UTC, handling both ISO 8601 (with T/Z) and bare
 * SQLite format (YYYY-MM-DD HH:MM:SS). The bare format is ambiguous —
 * browsers parse it as local time — so we append 'Z' to force UTC.
 */
export function parseUTCDate(dateStr: string): Date {
  if (dateStr.includes("T") || dateStr.endsWith("Z")) {
    return new Date(dateStr);
  }
  return new Date(`${dateStr.replace(" ", "T")}Z`);
}

/**
 * Format a date as relative time (e.g., "2 minutes ago", "just now")
 */
export function formatRelativeTime(date: string | Date): string {
  const now = Date.now();
  const then = typeof date === "string" ? parseUTCDate(date).getTime() : date.getTime();
  const diff = now - then;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return days === 1 ? "1 day ago" : `${days} days ago`;
  } else if (hours > 0) {
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  } else if (minutes > 0) {
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  } else if (seconds > 10) {
    return `${seconds} seconds ago`;
  }
  return "just now";
}

/**
 * Format a date as smart time - relative for recent, absolute for older.
 * Handles both past and future dates.
 */
export function formatSmartTime(dateStr: string): string {
  const date = parseUTCDate(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();

  // Future dates
  if (diffMs < 0) {
    const futureMins = Math.floor(-diffMs / 60000);
    const futureHours = Math.floor(futureMins / 60);
    const futureDays = Math.floor(futureHours / 24);

    if (futureMins < 1) return "in <1m";
    if (futureMins < 60) return `in ${futureMins}m`;
    if (futureHours < 6) return `in ${futureHours}h`;
    if (futureDays < 1) {
      const isToday = date.toDateString() === now.toDateString();
      if (isToday) {
        return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
      }
      return date.toLocaleDateString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
      });
    }
    return date.toLocaleDateString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    });
  }

  // Past dates
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);

  if (diffHours < 6) {
    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    return `${diffHours}h ago`;
  }

  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Format a date string as UTC time (e.g., "Mar 31, 04:00 UTC")
 */
export function formatUTCTime(dateStr: string): string {
  const date = parseUTCDate(dateStr);
  return `${date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  })} UTC`;
}

/**
 * Format a number in compact notation (e.g., 1.2K, 3.4M)
 */
export function formatCompactNumber(num: number): string {
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toString();
}

/**
 * Format a currency value (max 3 digits display)
 */
export function formatCurrency(amount: number): string {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1000) return `$${(amount / 1000).toFixed(1)}K`;
  if (amount >= 100) return `$${Math.round(amount)}`;
  if (amount >= 10) return `$${amount.toFixed(1)}`;
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  return `$${amount.toFixed(3)}`;
}

/**
 * Format a duration in milliseconds as human-readable string
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Format elapsed time between two dates (or from start to now).
 * Returns compact string like "2m", "1h 23m", "3d 4h".
 */
export function formatElapsed(start: string, end?: string | null): string {
  const startMs = parseUTCDate(start).getTime();
  const endMs = end ? parseUTCDate(end).getTime() : Date.now();
  const diffMs = endMs - startMs;
  if (diffMs < 0) return "—";

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  if (seconds > 0) return `${seconds}s`;
  return `${diffMs}ms`;
}
