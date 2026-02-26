/**
 * Type declarations for Cloudflare Workers test environment
 *
 * The cloudflare:test module is provided by @cloudflare/vitest-pool-workers
 * for integration testing with Workers bindings.
 */

declare module 'cloudflare:test' {
  import type { Env } from '../env';

  /**
   * The env object provides access to all Cloudflare bindings defined in wrangler.toml
   * during vitest tests.
   */
  export const env: Env;

  /**
   * Create a context for running isolated tests with specific bindings
   */
  export function createExecutionContext(): ExecutionContext;

  /**
   * Wait for scheduled events to complete in tests
   */
  export function waitOnExecutionContext(ctx: ExecutionContext): Promise<void>;
}
