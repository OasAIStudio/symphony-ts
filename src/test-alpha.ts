/**
 * test-alpha — Test foundation module.
 *
 * This is the first module in the test chain. Subsequent issues
 * will extend it with additional capabilities.
 */

/** Sentinel that confirms the module loaded successfully. */
export const TEST_ALPHA_READY = true as const;

/** Returns a greeting string for validation purposes. */
export function greet(name: string): string {
  return `Hello, ${name}!`;
}
