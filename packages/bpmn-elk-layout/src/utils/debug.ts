/**
 * Shared Debug Utilities
 * Centralized debug flag for consistent debug logging across the codebase.
 */

/**
 * Flag to indicate CLI mode where debug output should be suppressed
 * to ensure clean stdout output.
 */
let cliMode = false;

/**
 * Enable CLI mode which suppresses all debug output.
 * This should be called at the very start of the CLI entry point.
 */
export function enableCliMode(): void {
  cliMode = true;
}

/**
 * Check if CLI mode is enabled.
 */
export function isCliMode(): boolean {
  return cliMode;
}

/**
 * Check if debug logging is enabled.
 * Returns true only when DEBUG=true environment variable is set AND not in CLI mode.
 *
 * Use this function instead of the DEBUG constant to ensure CLI mode is respected.
 *
 * @example
 * ```bash
 * DEBUG=true bun run test -- -t "21-subprocess"
 * ```
 */
export function isDebugEnabled(): boolean {
  if (cliMode) return false;
  return typeof process !== 'undefined' && process.env?.['DEBUG'] === 'true';
}
