import { existsSync,readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Hono } from 'hono';

import { createAsrRelay } from './asr/relay';
import { createAsrWebSocketServer } from './asr/wsServer';
import { runMigrations } from './db/migrate';
import { sweepStaleReleaseUploads } from './lib/stateDir';
import { createMediaWorker } from './media/worker';
import { seedBuiltinKitsForAllOrgs } from './org/builtinKits';
import { seedBuiltinProvidersForAllOrgs } from './org/builtinProviders';
import { archiveRoutes } from './routes/admin/archives';
import { adminAuditRoutes } from './routes/admin/audit';
import { catalogRoutes } from './routes/admin/catalog';
import { adminDashboardRoutes } from './routes/admin/dashboard';
import { deptRoutes } from './routes/admin/departments';
import { adminModelRoutes } from './routes/admin/models';
import { adminProviderCardRoutes } from './routes/admin/providerCards';
import { adminProviderKeyRoutes } from './routes/admin/providerKeys';
import { adminReleaseRoutes } from './routes/admin/releases';
import { roleAdminRoutes } from './routes/admin/roles';
import { adminSsoBindingRoutes } from './routes/admin/ssoBindings';
import { adminUsageRoutes } from './routes/admin/usage';
import { adminUserRoutes } from './routes/admin/users';
import { agentMarketplaceRoutes } from './routes/agentMarketplace';
import { agentMarketplaceAdminRoutes } from './routes/agentMarketplaceAdmin';
import { asrRoutes } from './routes/asr';
import { auditReceiveRoutes } from './routes/audit';
import { authRoutes } from './routes/auth';
import { ssoBindRoutes } from './routes/auth/ssoBind';
import { changePasswordRoutes } from './routes/changePassword';
import { connectorIconUploadRoutes } from './routes/connectorIconUpload';
import { contentIconUploadRoutes } from './routes/contentIconUpload';
import { enterpriseModelsRoutes } from './routes/enterpriseModels';
import { htmlSharesRoutes } from './routes/htmlShares';
import { kitCatalogRoutes } from './routes/kitCatalog';
import { kitCatalogAdminRoutes } from './routes/kitCatalogAdmin';
import { mcpConnectorsRoutes } from './routes/mcpConnectors';
import { mcpGatewayRoutes } from './routes/mcpGateway';
import { mcpMarketplaceRoutes } from './routes/mcpMarketplace';
import { mcpSubmissionsRoutes } from './routes/mcpSubmissions';
import { meRoutes } from './routes/me';
import { meSsoBindingRoutes } from './routes/me/ssoBinding';
import { mediaRoutes } from './routes/media';
import { modelsRoutes } from './routes/models';
import { pagesRoutes } from './routes/pages';
import { proxyRoutes } from './routes/proxy';
import { releaseDownloadsRoutes } from './routes/releaseDownloads';
import { releaseInstallerUploadsRoutes } from './routes/releaseInstallerUploads';
import { roleVocabularyRoutes } from './routes/roleVocabulary';
import { setupAliasRoutes } from './routes/setupAlias';
import { shareDeploymentsRoutes } from './routes/shareDeployments';
import { skillMarketplaceRoutes } from './routes/skillMarketplace';
import { skillMarketplaceAdminRoutes } from './routes/skillMarketplaceAdmin';
import { skillSubmissionsRoutes } from './routes/skillSubmissions';
import { ssoRoutes } from './routes/sso';
import { ssoLogoUploadRoutes } from './routes/ssoLogoUpload';
import { updatesRoutes } from './routes/updates';
import { uploadRoutes } from './routes/uploads';
import { usageRoutes } from './routes/usage';

export function buildApp(): Hono {
  const app = new Hono();
  app.get('/health', (c) => c.json({ ok: true }));
  app.route('/', authRoutes);
  app.route('/', meRoutes);
  app.route('/', meSsoBindingRoutes);
  app.route('/', mcpMarketplaceRoutes);
  // Mounted BEFORE mcpConnectorsRoutes: Hono resolves overlapping patterns in
  // registration order, so the static GET /admin/mcp-connectors/submissions
  // must beat mcpConnectors' GET /admin/mcp-connectors/:id.
  app.route('/', mcpSubmissionsRoutes);
  app.route('/', mcpConnectorsRoutes);
  app.route('/', skillMarketplaceRoutes);
  app.route('/', kitCatalogRoutes);
  app.route('/', agentMarketplaceRoutes);
  // Mounted BEFORE skillMarketplaceAdminRoutes: mirrors the
  // mcpSubmissions-before-mcpConnectors ordering (registration order wins for
  // overlapping patterns).
  app.route('/', skillSubmissionsRoutes);
  app.route('/', skillMarketplaceAdminRoutes);
  app.route('/', kitCatalogAdminRoutes);
  app.route('/', agentMarketplaceAdminRoutes);
  app.route('/', roleVocabularyRoutes);
  app.route('/', modelsRoutes);
  app.route('/', usageRoutes);
  app.route('/', auditReceiveRoutes);
  app.route('/', proxyRoutes);
  app.route('/', deptRoutes);
  app.route('/', adminUserRoutes);
  app.route('/', adminProviderKeyRoutes);
  app.route('/', adminProviderCardRoutes);
  app.route('/', adminModelRoutes);
  app.route('/', roleAdminRoutes);
  app.route('/', adminAuditRoutes);
  app.route('/', adminUsageRoutes);
  app.route('/', asrRoutes);
  app.route('/', mediaRoutes);
  app.route('/', adminDashboardRoutes);
  app.route('/', archiveRoutes);
  app.route('/', catalogRoutes);
  app.route('/', updatesRoutes);
  app.route('/', releaseDownloadsRoutes);
  app.route('/', releaseInstallerUploadsRoutes);
  app.route('/', adminReleaseRoutes);
  app.route('/api/setup', setupAliasRoutes);
  app.route('/', changePasswordRoutes);
  app.route('/', enterpriseModelsRoutes);
  app.route('/', htmlSharesRoutes);
  app.route('/', shareDeploymentsRoutes);
  app.route('/', uploadRoutes);
  // Before `pagesRoutes` and the `app.get('*')` SPA fallback at the bottom of
  // this function: Hono answers in registration order, so a gateway mounted
  // after the fallback would answer GET with the console HTML — and GET is how
  // an MCP stream opens. POST would keep working, which is what makes the
  // mistake survive a smoke test.
  app.route('/', mcpGatewayRoutes);
  app.route('/', pagesRoutes);
  app.route('/', ssoRoutes);
  app.route('/', ssoBindRoutes);
  // The web /me/sso-binding/start flow's post-bind callback lives at
  // /auth/sso/callback (the same URL the org admin already registered
  // in the IdP developer console for the login flow) and is handled by
  // ssoRoutes — see sso.ts's GET /auth/sso/callback, which routes on
  // the parked context's returnTarget === 'web' to render the post-bind
  // HTML (localStorage token + sessionStorage.ssoBindJustSucceeded +
  // redirect to /account/sso-bindings). No separate /auth/sso/bind-callback
  // route exists: the org admin only registers one web URL with the IdP,
  // and any second URL would trigger Feishu 20029 "redirect_uri mismatch".
  app.route('/', adminSsoBindingRoutes);
  app.route('/', ssoLogoUploadRoutes);
  app.route('/', connectorIconUploadRoutes);
  app.route('/', contentIconUploadRoutes);

  // Static SSO logos:
  //  - /sso-logos/<file>          → built-in assets shipped in web/public/
  //    (Vite copies them into web-dist/sso-logos/ in prod; vite serves
  //    them directly in dev).
  //  - /sso-logos/uploads/<file>  → per-connection uploads written at
  //    runtime to <stateDir>/sso-logos/uploads/. Mounted UNCONDITIONALLY
  //    (not gated on the web build) so dev and prod both serve the
  //    upload directory.
  //
  // Without these routes the SPA fallback would return index.html for
  // image fetches and the <img> tags on the login page would render
  // broken.
  const imageMime: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    gif: 'image/gif',
  };
  app.get('/sso-logos/uploads/:file', async (c) => {
    const file = c.req.param('file');
    // Reject path-traversal characters and parent-directory references.
    if (file.includes('..') || file.includes('/') || file.includes('\\')) return c.notFound();
    const { ssoLogoUploadDir } = await import('./lib/stateDir');
    const fullPath = join(ssoLogoUploadDir(), file);
    if (!existsSync(fullPath)) return c.notFound();
    const buf = readFileSync(fullPath);
    const ext = file.split('.').pop()?.toLowerCase() ?? '';
    return c.body(buf, 200, { 'content-type': imageMime[ext] ?? 'application/octet-stream' });
  });

  // Static connector icons: per-connector uploads written at runtime to
  // <stateDir>/connector-icons/uploads/. Mounted UNCONDITIONALLY, before the
  // SPA fallback, so the admin console and the desktop can fetch the file from
  // the same origin as the API. An uploaded SVG is served with a sandboxing
  // CSP so a script inside it cannot run in this origin.
  // Static kit and skill icons, written by contentIconUpload.ts. Same shape as
  // the connector icons above.
  app.get('/kit-icons/uploads/:file', (c) => serveContentIcon(c.req.param('file'), 'kit'));
  app.get('/skill-icons/uploads/:file', (c) => serveContentIcon(c.req.param('file'), 'skill'));
  app.get('/agent-icons/uploads/:file', (c) => serveContentIcon(c.req.param('file'), 'agent'));

  /** Serve one uploaded kit / skill icon, or 404. */
  async function serveContentIcon(file: string, kind: 'kit' | 'skill' | 'agent'): Promise<Response> {
    if (file.includes('..') || file.includes('/') || file.includes('\\')) {
      return new Response('not found', { status: 404 });
    }
    const { agentIconUploadDir, kitIconUploadDir, skillIconUploadDir } = await import('./lib/stateDir');
    const dir = kind === 'kit'
      ? kitIconUploadDir()
      : kind === 'skill'
        ? skillIconUploadDir()
        : agentIconUploadDir();
    const fullPath = join(dir, file);
    if (!existsSync(fullPath)) return new Response('not found', { status: 404 });
    const buf = readFileSync(fullPath);
    const ext = file.split('.').pop()?.toLowerCase() ?? '';
    return new Response(buf, {
      status: 200,
      headers: {
        'content-type': imageMime[ext] ?? 'application/octet-stream',
        'content-security-policy': 'sandbox',
        'cache-control': 'public, max-age=300',
      },
    });
  }

  app.get('/connector-icons/uploads/:file', async (c) => {
    const file = c.req.param('file');
    if (file.includes('..') || file.includes('/') || file.includes('\\')) return c.notFound();
    const { connectorIconUploadDir } = await import('./lib/stateDir');
    const fullPath = join(connectorIconUploadDir(), file);
    if (!existsSync(fullPath)) return c.notFound();
    const buf = readFileSync(fullPath);
    const ext = file.split('.').pop()?.toLowerCase() ?? '';
    return c.body(buf, 200, {
      'content-type': imageMime[ext] ?? 'application/octet-stream',
      'content-security-policy': 'sandbox',
      'cache-control': 'public, max-age=300',
    });
  });

  // Static SPA (web-dist/) + history fallback. Only mounted when the build
  // output exists; otherwise the API-only server still works. The wildcard
  // must come after every API route so /api/* and /admin/* are never
  // shadowed by the SPA fallback.
  const webDist = process.env.WEB_DIST_DIR ?? join(process.cwd(), 'web-dist');
  const indexHtml = join(webDist, 'index.html');
  const assetsDir = join(webDist, 'assets');

  if (existsSync(indexHtml)) {
    app.get('/assets/*', async (c) => {
      const rel = c.req.path.replace(/^\/assets\//, '');
      const file = join(assetsDir, rel);
      if (!existsSync(file)) return c.notFound();
      const buf = readFileSync(file);
      const ext = rel.split('.').pop() ?? '';
      const mime = ext === 'js' ? 'text/javascript' : ext === 'css' ? 'text/css' : 'application/octet-stream';
      return c.body(buf, 200, { 'content-type': mime });
    });
    // IM channel logos (web/public/im-logos/) referenced by absolute /im-logos/*
    // paths in the SPA. Without this route they fall through to the wildcard
    // below and return index.html, so the <img> tags render broken.
    const imLogosDir = join(webDist, 'im-logos');
    const imageMime: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      svg: 'image/svg+xml',
      webp: 'image/webp',
    };
    app.get('/im-logos/*', async (c) => {
      const rel = c.req.path.replace(/^\/im-logos\//, '');
      const file = join(imLogosDir, rel);
      if (!existsSync(file)) return c.notFound();
      const buf = readFileSync(file);
      const ext = rel.split('.').pop()?.toLowerCase() ?? '';
      const mime = imageMime[ext] ?? 'application/octet-stream';
      return c.body(buf, 200, { 'content-type': mime });
    });
    // Built-in agent avatars (web/public/agent-avatars/) referenced by
    // absolute /agent-avatars/* paths in the SPA. Same reason as the two
    // routes above: without it the wildcard returns index.html.
    const agentAvatarsDir = join(webDist, 'agent-avatars');
    app.get('/agent-avatars/*', async (c) => {
      const rel = c.req.path.replace(/^\/agent-avatars\//, '');
      const file = join(agentAvatarsDir, rel);
      if (!existsSync(file)) return c.notFound();
      const buf = readFileSync(file);
      const ext = rel.split('.').pop()?.toLowerCase() ?? '';
      const mime = imageMime[ext] ?? 'application/octet-stream';
      return c.body(buf, 200, { 'content-type': mime });
    });
    // Brand logo (web/public/brand/) referenced by absolute /brand/* paths in
    // the SPA. Without this route it would fall through to the wildcard below
    // and return index.html, so the <img> tags render broken.
    const brandDir = join(webDist, 'brand');
    app.get('/brand/*', async (c) => {
      const rel = c.req.path.replace(/^\/brand\//, '');
      const file = join(brandDir, rel);
      if (!existsSync(file)) return c.notFound();
      const buf = readFileSync(file);
      const ext = rel.split('.').pop()?.toLowerCase() ?? '';
      const mime = imageMime[ext] ?? 'application/octet-stream';
      return c.body(buf, 200, { 'content-type': mime });
    });
    // Built-in SSO logos (web/public/sso-logos/) referenced as
    // /sso-logos/<file> in the public /auth/sso/providers response when
    // the connection has no per-connection override. Without this route
    // the SPA fallback returns index.html and the login page icons break.
    // /sso-logos/uploads/<file> is served by the unconditional route
    // above (mounted before this block) and falls through here as
    // /sso-logos/<file> with name 'uploads' — that case returns 404
    // because there is no file named `uploads` in ssoLogosDir.
    const ssoLogosDir = join(webDist, 'sso-logos');
    app.get('/sso-logos/:file', async (c) => {
      const file = c.req.param('file');
      if (file.includes('..') || file.includes('/') || file.includes('\\')) return c.notFound();
      const full = join(ssoLogosDir, file);
      if (!existsSync(full)) return c.notFound();
      const buf = readFileSync(full);
      const ext = file.split('.').pop()?.toLowerCase() ?? '';
      return c.body(buf, 200, { 'content-type': imageMime[ext] ?? 'application/octet-stream' });
    });
    app.get('*', (c) => {
      return c.html(readFileSync(indexHtml, 'utf8'));
    });
  }

  return app;
}

export async function serve(): Promise<void> {
  await runMigrations();
  // Spec §6: best-effort GC of chunked-upload staging older than 24h. Wrapped
  // because it touches the on-disk state dir; failures must never block the
  // server from booting. `sweepStaleReleaseUploads` already catches per-dir
  // errors; this catches startup-time surprises.
  try {
    const n = await sweepStaleReleaseUploads();
    if (n > 0) console.log(`[ReleaseUploads] swept ${n} stale staging dir(s)`);
  } catch (e) {
    console.warn('[ReleaseUploads] staging GC failed', e);
  }
  await seedBuiltinProvidersForAllOrgs();
  await seedBuiltinKitsForAllOrgs();
  const app = buildApp();
  const port = Number(process.env.PORT ?? '8787');
  // node:http serve：避免再拉 @hono/node-server
  const { createServer } = await import('node:http');
  // The request listener lives in `http/nodeAdapter.ts` so the streaming
  // decision (installer ranges + MCP's SSE channel) is testable against a real
  // socket. Loaded lazily, like `node:http` itself.
  const { createNodeRequestHandler } = await import('./http/nodeAdapter');
  const server = createServer(createNodeRequestHandler(app));
  // The ASR websocket upgrade is intercepted BEFORE Hono: `node:http` has no
  // notion of a websocket, so the upgrade would otherwise be answered as an
  // ordinary request and log a confusing error.
  const asrRelay = createAsrRelay();
  const asrWs = createAsrWebSocketServer((socket, request) => {
    void asrRelay.handleConnection(socket, request);
  });
  server.on('upgrade', asrWs.handleUpgrade);

  // The media worker advances queued generation tasks. It is an interval rather
  // than a per-request spin: the desktop polls task status, and a task whose
  // upstream never answers has to be failed by the SERVER eventually, or the
  // client polls until it dies.
  const mediaWorker = createMediaWorker();
  const workerTimer = setInterval(() => {
    void mediaWorker.runOnce().catch((e) => console.warn('[MediaWorker] pass failed', e));
    // Expiry runs in the interval, not once at boot: a task that goes stale
    // AFTER startup would otherwise stay running forever, and the desktop
    // would poll it until it died.
    void mediaWorker.expireStaleTasks().catch((e) => console.warn('[MediaWorker] expiry pass failed', e));
  }, 5_000);

  server.listen(port, () => {
    console.log(`enterprise_server listening on :${port}`);
  });

  const shutdown = (): void => {
    clearInterval(workerTimer);
    server.close();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  serve().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}