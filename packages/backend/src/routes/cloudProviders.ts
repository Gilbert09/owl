import { Router } from 'express';
import type { CloudProviderType, ApiResponse } from '@talyn/shared';
import { assertUser, handleAccessError, requireWorkspaceAccess } from '../middleware/auth.js';
import { getCloudProvider, listCloudProviders } from '../services/cloudProviders/registry.js';
import { ensureCloudEnvironment } from '../services/cloudProviders/environment.js';
import { fleetRefusalReason, workspaceMayUseFleet } from '../services/cloudProviders/fleetAccess.js';

interface CloudProviderInfo {
  type: CloudProviderType;
  displayName: string;
  capabilities?: { model?: boolean; runtimeAdapter?: boolean };
  connected: boolean;
}

/**
 * Generic, provider-agnostic surface for cloud task providers. Lists the
 * registered providers + their per-workspace connection status, and proxies
 * credential CRUD to each provider's own methods. Adding a provider needs
 * no change here — it registers in index.ts and shows up automatically.
 */
export function cloudProviderRoutes(): Router {
  const router = Router();

  // List providers + connected status for a workspace.
  router.get('/', async (req, res) => {
    const workspaceId = req.query.workspaceId as string | undefined;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    // Hiding a provider this workspace may not use is COSMETIC — it keeps the
    // settings screen honest, and nothing more. The gate that matters is at
    // dispatch and at credential-write below, because a filtered list is not a
    // permission check: the CLI, the MCP server and curl never render it.
    const mayUseFleet = await workspaceMayUseFleet(workspaceId);
    const providers: CloudProviderInfo[] = await Promise.all(
      listCloudProviders()
        .filter((p) => p.type !== 'selfhosted' || mayUseFleet)
        .map(async (p) => ({
          type: p.type,
          displayName: p.displayName,
          capabilities: p.capabilities,
          connected: await p.hasCredentials(workspaceId),
        })),
    );
    res.json({ success: true, data: providers } as ApiResponse<CloudProviderInfo[]>);
  });

  // Validate + store credentials, then auto-provision the env marker.
  router.put('/:type/config', async (req, res) => {
    const provider = getCloudProvider(req.params.type);
    if (!provider) {
      return res.status(404).json({ success: false, error: 'Unknown cloud provider' });
    }
    const { workspaceId } = req.body as { workspaceId?: string };
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }

    // Refuse before any credential is validated or stored. A workspace that
    // cannot dispatch to the fleet has no business holding a fleet token: it
    // would sit encrypted in the integrations row forever, and the first thing
    // anyone would try after being told "not allowed" is to configure it again.
    if (provider.type === 'selfhosted' && !(await workspaceMayUseFleet(workspaceId))) {
      return res.status(403).json({ success: false, error: fleetRefusalReason() });
    }

    const result = await provider.validateCredentials(workspaceId, req.body);
    if (!result.ok) {
      return res.status(400).json({ success: false, error: result.error });
    }
    await ensureCloudEnvironment(assertUser(req).id, provider.type);
    res.json({ success: true, data: { connected: true } });
  });

  router.post('/:type/test', async (req, res) => {
    const provider = getCloudProvider(req.params.type);
    if (!provider) {
      return res.status(404).json({ success: false, error: 'Unknown cloud provider' });
    }
    const { workspaceId } = req.body as { workspaceId?: string };
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    const data = provider.testConnection
      ? await provider.testConnection(workspaceId)
      : { connected: await provider.hasCredentials(workspaceId) };
    res.json({ success: true, data });
  });

  router.delete('/:type/config', async (req, res) => {
    const provider = getCloudProvider(req.params.type);
    if (!provider) {
      return res.status(404).json({ success: false, error: 'Unknown cloud provider' });
    }
    const workspaceId = req.query.workspaceId as string | undefined;
    if (!workspaceId) {
      return res.status(400).json({ success: false, error: 'workspaceId is required' });
    }
    try {
      await requireWorkspaceAccess(req, workspaceId);
    } catch (err) {
      return handleAccessError(err, res);
    }
    await provider.removeCredentials(workspaceId);
    res.json({ success: true } as ApiResponse<void>);
  });

  return router;
}
