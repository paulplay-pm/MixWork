import { useEffect, useState } from 'react';

import { i18nService } from '@/services/i18n';
import { EnterpriseSetupModal } from '@/setup/EnterpriseSetupModal';

const t = (key: string): string => i18nService.t(key);

interface EnterpriseMtBridge {
  getBootstrapStatus: () => Promise<{ configured: boolean; url: string | null }>;
  verifyUrl: (url: string) => Promise<{ ok: boolean; error?: string }>;
  saveUrl: (
    url: string,
  ) => Promise<{ ok: boolean; status?: { configured: boolean; url: string | null }; error?: string }>;
  logout: () => Promise<void>;
  quit: () => Promise<void>;
}

const getBridge = (): EnterpriseMtBridge | null => {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    electron?: { enterpriseMt?: EnterpriseMtBridge };
  };
  return win.electron?.enterpriseMt ?? null;
};

/**
 * Settings-row entry that lets the user change the enterprise server URL
 * after the desktop has already been configured. Mounted under the General
 * tab.
 *
 * The click handler opens EnterpriseSetupModal in `edit` mode, which:
 *   - drops the Quit action (no reason to leave the app)
 *   - adds Cancel (dismiss without saving)
 *   - surfaces a Test Connection button
 *   - shows an amber "please restart the app" notice
 *
 * On Save the new URL is persisted. The change only takes effect after the
 * user restarts the app, which the modal reminds them of — there is no
 * auto-relaunch.
 */
export function EnterpriseServerSetting(): JSX.Element {
  const [currentUrl, setCurrentUrl] = useState<string>('');
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);

  useEffect(() => {
    const bridge = getBridge();
    if (!bridge) return;
    let cancelled = false;
    void bridge.getBootstrapStatus().then((status) => {
      if (!cancelled && status.url) {
        setCurrentUrl(status.url);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const bridge = getBridge();
  if (!bridge) {
    return <></>;
  }

  const subtitle = currentUrl
    ? `${t('enterpriseSettings.entrySubtitle')} ${currentUrl}`
    : t('enterpriseSettings.entrySubtitle');

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-medium text-foreground">
            {t('enterpriseSettings.entryTitle')}
          </h4>
          <p className="mt-1 text-sm text-secondary truncate" title={currentUrl}>
            {subtitle}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setIsModalOpen(true)}
          className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-raised"
        >
          {t('enterpriseSettings.edit')}
        </button>
      </div>
      {isModalOpen && (
        <EnterpriseSetupModal
          initialUrl={currentUrl}
          mode="edit"
          onVerify={(url) => bridge.verifyUrl(url)}
          onSave={async (url) => {
            const result = await bridge.saveUrl(url);
            if (result.ok && result.status?.url) {
              setCurrentUrl(result.status.url);
            }
            if (result.ok) {
              // URL is persisted to SQLite + process.env on the main side.
              // The OpenClaw gateway / Cowork baseURL still point at the
              // previous URL until the app restarts, so sign the user out
              // (clears the JWT) and reload the renderer. The next login
              // picks up the new enterprise URL.
              try {
                await bridge.logout();
              } catch {
                // Best-effort: the reload below still gets us back to the
                // login page even if the IPC reply is lost.
              }
              window.location.reload();
            }
            return result;
          }}
          onQuit={() => bridge.quit()}
          onCancel={() => setIsModalOpen(false)}
        />
      )}
    </>
  );
}