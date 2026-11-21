/**
 * Process startup instrumentation hook (Phase 18 Observability, Issue 352 / #464).
 *
 * This module MUST be loaded before any application modules or libraries are required,
 * ensuring OpenTelemetry's monkey-patching hooks intercept module loading correctly.
 */
import { initOtelBootstrap } from "@verixa/observability";

export const otelBootstrapResult = initOtelBootstrap();

export { initOtelBootstrap };
