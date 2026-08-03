/**
 * Re-export of the shared backend client, mirroring the desktop's
 * apps/desktop/src/renderer/lib/api.ts.
 *
 * Both front ends keep a module at this path so the ~40 components that
 * `import { api, … } from '../lib/api'` read identically in either tree —
 * which is what lets a panel be ported by copying it. The actual transport
 * lives in @talyn/client; the browser's configuration of it is in
 * ./apiClient, imported for side effect by main.tsx before anything renders.
 */
export * from '@talyn/client';
