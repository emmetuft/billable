import type { ActivitySnapshot } from './types';

export interface ExclusionRules {
  excludedApplications: string[];
  excludedDomains: string[];
  excludedTitleKeywords: string[];
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Case-insensitive match. Excluded snapshots are recorded with no application/title metadata. */
export function isExcluded(snapshot: ActivitySnapshot, rules: ExclusionRules): boolean {
  const names = [snapshot.application, snapshot.processName ?? '']
    .filter(Boolean)
    .map((n) => n.toLowerCase());
  if (rules.excludedApplications.some((a) => names.includes(a.toLowerCase()))) return true;

  const title = `${snapshot.windowTitle} ${snapshot.browserTabTitle ?? ''}`.toLowerCase();
  if (rules.excludedTitleKeywords.some((k) => title.includes(k.toLowerCase()))) return true;

  if (snapshot.browserUrl) {
    const host = hostOf(snapshot.browserUrl);
    if (
      host &&
      rules.excludedDomains.some((d) => {
        const domain = d.toLowerCase().replace(/^\*?\./, '');
        return host === domain || host.endsWith(`.${domain}`);
      })
    ) {
      return true;
    }
  }
  return false;
}
