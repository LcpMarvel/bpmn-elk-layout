/**
 * CLI Binary Entry Point
 *
 * Enable CLI mode first to suppress debug logging before any other imports.
 * Uses dynamic import to ensure the order of execution.
 */

import { enableCliMode } from '../utils/debug';

// Enable CLI mode to suppress debug logging
// This must be called before importing the CLI module
enableCliMode();

// Now import and run the CLI using dynamic import
// This ensures enableCliMode() is executed before any CLI dependencies are loaded
import('../cli');
