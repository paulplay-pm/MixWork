import { createHmac } from 'node:crypto';

import { expect, type Page, test } from '@playwright/test';

/**
 * Providers & models visual baselines — captured against a REAL, seeded
 * backend (the isolated acceptance server: `runMigrations` +
 * `seedBuiltinProviders` against a throwaway DB, with one custom provider + a
 * key on at least one provider so the masked hint renders). A properly
 * HS256-signed token (sub = a super-admin user, real orgId) is seeded so the
 * proxied `/admin/provider-cards` + `/admin/models` + `/admin/model-type-defaults`
 * + `/me` calls authenticate and the page renders the seeded data. Signed with
 * `node:crypto` because web has no `jose` dependency (mirrors
 * `users.spec.ts`).
 *
 * The page is CARD-shaped: the rail has one row per vendor (a vendor offering
 * four model types is ONE row, and the row names the vendor only), and the
 * detail pane is one card whose model-type tab bar holds one section per
 * model type. Every model type's section — LLM, speech, image, video —
 * renders the SAME model table (model / model capability / context window /
 * enabled / actions); there is no media textarea any more.
 *
 * NOTE: baselines ARE captured — against a real, isolated, seeded throwaway
 * backend (a Docker `postgres:16` container with `runMigrations` +
 * `seedBuiltinProviders`, plus the real `enterprise_server` on spare ports;
 * the dev `mixwork` DB was never touched). The screenshots are gitignored and
 * local-only (web/.gitignore ignores tests/visual/screenshots/) — NOT
 * committed. Regenerate them with `npm run test:visual:update` (or directly):
 *   WEB_PORT=<spare> WEB_PROXY_TARGET=<backend> WEB_ORG_ID=<org> \
 *   WEB_JWT_SECRET=<secret> npx playwright test tests/visual/providers.spec.ts --update-snapshots
 * from `enterprise_server/web/`.
 */
const JWT_SECRET =
  process.env.WEB_JWT_SECRET ??
  '74c0a5f6488345f01952c49164069108ad0a348a981c6fbdaf18f066e487cb6c';
const ORG_ID = process.env.WEB_ORG_ID ?? 'org-model-provider';
const SUPER_SUB = 'u-acceptance-super-admin';

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signToken(claims: Record<string, unknown>): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64url(Buffer.from(JSON.stringify(claims)));
  const data = `${header}.${payload}`;
  const sig = b64url(createHmac('sha256', JWT_SECRET).update(data).digest());
  return `${data}.${sig}`;
}

function seedAuth(page: Page): void {
  const token = signToken({
    orgId: ORG_ID,
    roles: ['super_admin'],
    sub: SUPER_SUB,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  void page.addInitScript(
    ({ tok, c }) => {
      const trySeed = (): void => {
        import('/src/auth/store.ts')
          .then((mod) => {
            mod.useAuthStore.setState({ token: tok, claims: c });
          })
          .catch(() => {
            requestAnimationFrame(trySeed);
          });
      };
      requestAnimationFrame(trySeed);
    },
    { tok: token, c: { sub: SUPER_SUB, orgId: ORG_ID, roles: ['super_admin'] } }
  );
}

async function gotoProviders(page: Page): Promise<void> {
  seedAuth(page);
  await page.goto('/config/providers');
  // Wait for the rail to render (providers + models fetched). The two group
  // headings are the reliable "loaded" markers.
  await expect(page.getByRole('heading', { name: /Built-in/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Custom/i })).toBeVisible();
}

test.describe('providers & models visual baselines', () => {
  test('vendor card rail: one row per card, grouped, naming the vendor only', async ({ page }) => {
    await gotoProviders(page);
    // A couple of the seeded built-ins (by slug) are visible in the rail.
    await expect(page.getByText('openai', { exact: true })).toBeVisible();
    await expect(page.getByText('anthropic', { exact: true })).toBeVisible();
    // One row per CARD, and the row names the vendor only — the model types
    // live in the card's tab bar, not in the rail.
    const rail = page.locator('div.w-72');
    expect(await rail.getByText('LLM (VLM)', { exact: true }).count()).toBe(0);
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('providers-list.png', { fullPage: true });
  });

  test('vendor card: header, name, model-type tabs, LLM section', async ({ page }) => {
    await gotoProviders(page);
    // Select the `anthropic` built-in (protocol=anthropic → the Anthropic radio
    // is checked). A seeded key on the section makes the masked hint render.
    await page.getByText('anthropic', { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Test connection' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
    // The card's name box and its four model-type tabs. All four are always
    // there; the one that has a credential is the open tab.
    await expect(page.getByLabel('Provider name')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'LLM (VLM)' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Speech recognition' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Image generation' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Video generation' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'LLM (VLM)' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // The tabs stand alone — no group caption — but the tab list still names
    // itself for assistive tech.
    await expect(page.getByRole('tablist')).toHaveAttribute('aria-label', 'Model types');
    // The section's protocol radio: the seeded row speaks anthropic.
    await expect(page.getByRole('radio', { name: 'Anthropic compatible' })).toBeChecked();
    // The section's model table is the SAME table for every capability.
    await expect(page.getByRole('columnheader', { name: 'Context window' })).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('provider-detail.png', { fullPage: true });
  });

  test('model drawer: the section types + context + sampling', async ({ page }) => {
    await gotoProviders(page);
    // Enter detail mode (a card must be selected for the section's model table
    // and its "Add model" action to render). The drawer is opened PER SECTION,
    // so the button lives inside the LLM section.
    await page.getByText('openai', { exact: true }).click();
    const addModel = page.getByRole('button', { name: 'Add model' });
    await expect(addModel.first()).toBeVisible();
    await addModel.first().click();
    // The drawer opens as a fixed overlay. Scope assertions to it — the model
    // table also renders a "Context window" column header, so an unscoped
    // getByText would hit both (strict-mode violation).
    const drawer = page.locator('div.fixed.inset-0.z-50');
    await expect(drawer.getByRole('heading', { name: 'Add model' })).toBeVisible();
    await expect(drawer.getByText('Basic info', { exact: true })).toBeVisible();
    await expect(drawer.getByText('Model capabilities', { exact: true })).toBeVisible();
    // The drawer offers ONLY the section's capability types: a chat section
    // carries no image / speech / video type.
    await expect(drawer.getByText('Chat', { exact: true })).toBeVisible();
    await expect(drawer.getByText('Rerank', { exact: true })).toBeVisible();
    await expect(drawer.getByText('Image generation', { exact: true })).toHaveCount(0);
    await expect(drawer.getByText('Context window', { exact: true })).toBeVisible();
    // Sampling params (temperature / top P).
    await expect(drawer.getByText('Temperature', { exact: true })).toBeVisible();
    await expect(drawer.getByText('Top P', { exact: true })).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('model-drawer.png', { fullPage: true });
  });
});
