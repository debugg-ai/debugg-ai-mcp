/**
 * Debugg tunnel wire protocol v1 — public surface.
 *
 * The MCP tunnel client (services/tunnel/) and the debugg tunnel server both
 * import from here and nowhere deeper. Conformance vectors for any copy of this
 * module live in ./vectors/.
 *
 * Spec: bead debugg_ai_mcp-xkoh.1.2. Design: docs/debugg-tunnel-server-design-2026-09-19.md §3.
 */

export * from './constants.js';
export * from './errors.js';
export * from './codec.js';
export * from './transport.js';
export * from './stream.js';
export * from './session.js';
export * from './handshake.js';
export * from './conformance.js';
