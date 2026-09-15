/**
 * The shared UI layer (§54): one component set, one API client, one design vocabulary.
 *
 * `apps/web` renders these components in the browser; the Electron desktop shell loads
 * the same bundle from `dist/web`. Nothing in here branches on the shell — where
 * behaviour differs, it is read from `window.aido` (desktop) or reported by the API.
 */
export * from './lib/format.js';
export * from './api/client.js';
export * from './components/primitives.js';
export * from './components/Resource.js';
