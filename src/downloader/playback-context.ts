import type { MediaCandidate } from '../shared/media';

function httpPageUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function sessionRuleId(): number {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return 1 + (random[0] % 2_000_000_000);
}

export function requestDomains(candidates: MediaCandidate[]): string[] {
  const domains = new Set<string>();
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate.url);
      if (url.protocol === 'http:' || url.protocol === 'https:') domains.add(url.hostname);
    } catch {
      // Invalid candidates are handled by the caller when the request is made.
    }
  }
  return [...domains];
}

export interface PlaybackContextOptions {
  sourcePageUrl?: string;
  fallbackPageUrls?: Array<string | undefined>;
  requestDomains?: string[];
}

export async function installPlaybackContextRule(options: PlaybackContextOptions): Promise<number | null> {
  const referer = httpPageUrl(options.sourcePageUrl)
    ?? options.fallbackPageUrls?.map(httpPageUrl).find((value): value is string => Boolean(value))
    ?? null;
  if (!referer) return null;

  const managerTab = await chrome.tabs.getCurrent().catch(() => null);
  if (managerTab?.id == null) return null;

  const ruleId = sessionRuleId();
  const condition: chrome.declarativeNetRequest.RuleCondition = {
    tabIds: [managerTab.id],
    resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST]
  };

  if (options.requestDomains && options.requestDomains.length > 0) {
    condition.requestDomains = [...new Set(options.requestDomains)];
  }

  const rule: chrome.declarativeNetRequest.Rule = {
    id: ruleId,
    priority: 100,
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
      requestHeaders: [{
        header: 'Referer',
        operation: chrome.declarativeNetRequest.HeaderOperation.SET,
        value: referer
      }]
    },
    condition
  };

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [rule]
  });
  return ruleId;
}

export async function removePlaybackContextRule(ruleId: number | null): Promise<void> {
  if (ruleId == null) return;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId]
  }).catch(() => undefined);
}
