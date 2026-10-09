/**
 * Echoing a rejected form back to the user.
 *
 * React resets an uncontrolled form once its action resolves. Without handing
 * the submitted values back, a single validation error -- one unqualified
 * therapist, one clashing slot -- would wipe everything else that was typed and
 * make the person re-enter a whole booking to fix one field.
 *
 * Lives outside the "use server" action modules because those may only export
 * async functions.
 */

/** Fields that must never be echoed back into rendered HTML. */
const NEVER_ECHO = new Set(["password", "confirmPassword", "signature"]);

export function submittedValues(formData: FormData): Record<string, string> {
  const values: Record<string, string> = {};

  for (const [key, value] of formData.entries()) {
    // Skip React's own action plumbing, files, and anything secret.
    if (typeof value !== "string") continue;
    if (key.startsWith("$")) continue;
    if (NEVER_ECHO.has(key)) continue;
    values[key] = value;
  }

  return values;
}
