export interface DashManifestRoot {
  documentNode: Document;
  mpd: Element;
  isDynamic: boolean;
}

export function parseDashManifestRoot(xml: string): DashManifestRoot {
  const documentNode = new DOMParser().parseFromString(xml, 'application/xml');
  if (documentNode.querySelector('parsererror')) {
    throw new Error('Invalid DASH MPD.');
  }
  const mpd = documentNode.documentElement;
  if (mpd.localName !== 'MPD') {
    throw new Error('Invalid DASH MPD root element.');
  }
  return {
    documentNode,
    mpd,
    isDynamic: mpd.getAttribute('type') === 'dynamic'
  };
}
