/** Stable sentinel used by the custom JSON parser and responsibility-specific
 * handlers. Identity comparison distinguishes malformed JSON from a valid
 * object that happens to contain the same field. */
export const INVALID_JSON_BODY = Object.freeze({ invalidJSONBody: true });
