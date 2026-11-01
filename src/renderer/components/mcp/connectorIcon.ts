/**
 * Where a connector's brand logo comes from.
 *
 * Two sources, in order:
 *
 * 1. The icon stored on the local record. It is copied from the org's catalog
 *    when the connector is installed, so it survives the catalog page being
 *    closed and needs no network.
 * 2. The org's catalog, looked up by the connector's serverKey. This is what
 *    covers the connectors that were installed before the desktop started
 *    storing the icon: the org already has the logo, the local record just
 *    does not know about it yet.
 */

export interface ConnectorIconSource {
  /** The icon stored on the local record, if the install captured one. */
  icon?: string | null;
  /** The connector's catalog key. */
  serverKey?: string | null;
}

/** The logo for a connector, or undefined when nothing knows one. */
export function resolveConnectorIcon(
  server: ConnectorIconSource,
  catalogIcons: Record<string, string>,
): string | undefined {
  // The catalog wins for a connector that has one. The copy on the record is
  // written at install time, so an admin who replaces the logo in the console
  // would otherwise leave this desktop showing the old one — and the old
  // file is gone, so it would show nothing at all.
  const key = server.serverKey?.trim();
  const fromCatalog = key ? catalogIcons[key]?.trim() : '';
  if (fromCatalog) return fromCatalog;
  const stored = server.icon?.trim();
  return stored ? stored : undefined;
}

/** The catalog's logos, keyed by the connector's serverKey. */
export function catalogIconsByServerKey(
  servers: Array<{ serverKey: string; icon?: string | null }>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of servers) {
    const icon = entry.icon?.trim();
    if (entry.serverKey && icon) map[entry.serverKey] = icon;
  }
  return map;
}
