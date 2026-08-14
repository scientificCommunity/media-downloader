import { dashBase, dashChild, dashChildren, dashNumber } from './dash-xml';

export interface DashRepresentationMeta {
  id: string;
  kind: 'video' | 'audio';
  bandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
  mimeType?: string;
  baseUrl: string;
  initializationTemplate: string;
  mediaTemplate: string;
  timescale: number;
  startNumber: number;
  duration?: number;
  timeline?: Array<{ t?: number; d: number; r?: number }>;
}

function kindOf(adaptation: Element, representation: Element): 'video' | 'audio' | null {
  const contentType = representation.getAttribute('contentType') ?? adaptation.getAttribute('contentType') ?? '';
  const mimeType = representation.getAttribute('mimeType') ?? adaptation.getAttribute('mimeType') ?? '';
  if (contentType === 'video' || mimeType.startsWith('video/')) return 'video';
  if (contentType === 'audio' || mimeType.startsWith('audio/')) return 'audio';
  return null;
}

function inherited(primary: Element | null, fallback: Element | null, name: string): string | undefined {
  return primary?.getAttribute(name) ?? fallback?.getAttribute(name) ?? undefined;
}

function timelineOf(template: Element): DashRepresentationMeta['timeline'] {
  const timeline = dashChild(template, 'SegmentTimeline');
  if (!timeline) return undefined;
  const items = dashChildren(timeline, 'S').flatMap((item) => {
    const d = dashNumber(item, 'd');
    return d && d > 0 ? [{ t: dashNumber(item, 't'), d, r: dashNumber(item, 'r') }] : [];
  });
  return items.length ? items : undefined;
}

export function parseRepresentationMeta(
  adaptation: Element,
  representation: Element,
  adaptationBase: string
): DashRepresentationMeta | null {
  const kind = kindOf(adaptation, representation);
  if (!kind) return null;
  const ownTemplate = dashChild(representation, 'SegmentTemplate');
  const sharedTemplate = dashChild(adaptation, 'SegmentTemplate');
  const template = ownTemplate ?? sharedTemplate;
  if (!template) return null;
  const mediaTemplate = inherited(ownTemplate, sharedTemplate, 'media');
  const initializationTemplate = inherited(ownTemplate, sharedTemplate, 'initialization');
  if (!mediaTemplate || !initializationTemplate) return null;
  return {
    id: representation.getAttribute('id') ?? `${kind}-${representation.getAttribute('bandwidth') ?? '0'}`,
    kind,
    bandwidth: dashNumber(representation, 'bandwidth'),
    width: dashNumber(representation, 'width'),
    height: dashNumber(representation, 'height'),
    codecs: representation.getAttribute('codecs') ?? adaptation.getAttribute('codecs') ?? undefined,
    mimeType: representation.getAttribute('mimeType') ?? adaptation.getAttribute('mimeType') ?? undefined,
    baseUrl: dashBase(adaptationBase, representation),
    initializationTemplate,
    mediaTemplate,
    timescale: dashNumber(template, 'timescale') ?? 1,
    startNumber: dashNumber(template, 'startNumber') ?? 1,
    duration: dashNumber(template, 'duration'),
    timeline: timelineOf(template)
  };
}
