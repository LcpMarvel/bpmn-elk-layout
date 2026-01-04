/**
 * Shared Debug Utilities
 * Centralized debug flag for consistent debug logging across the codebase.
 */

/**
 * Debug flag from environment variable.
 * Set DEBUG=true to enable debug logging.
 *
 * @example
 * ```bash
 * DEBUG=true bun run test -- -t "21-subprocess"
 * ```
 */
export const DEBUG =
  typeof process !== 'undefined' && process.env?.['DEBUG'] === 'true';
