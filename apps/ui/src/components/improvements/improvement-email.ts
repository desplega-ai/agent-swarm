const IMPROVEMENT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A send needs a valid email: the server refuses one without it (400). */
export const isValidImprovementEmail = (value: string) =>
  value.trim().length <= 320 && IMPROVEMENT_EMAIL_RE.test(value.trim());
