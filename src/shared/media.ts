export type MediaKind = 'direct' | 'hls' | 'dash' | 'segment' | 'unknown';
export type MediaSource = 'network' | 'dom';
export type MediaTrackKind = 'video' | 'audio' | 'unknown';

export interface MediaCandidate {
  id: string;
  url: string;
  kind: MediaKind;
  source: MediaSource;
  tabId: number;
  trackKind?: MediaTrackKind;
  contentType?: string;
  contentLength?: number;
  contentRange?: string;
  acceptRanges?: boolean;
  statusCode?: number;
  requestType?: string;
  requestCount?: number;
  pageUrl?: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface MediaCandidateMessage {
  type: 'GET_MEDIA_CANDIDATES';
  tabId: number;
}

export interface ClearMediaCandidatesMessage {
  type: 'CLEAR_MEDIA_CANDIDATES';
  tabId: number;
}

export type BackgroundMessage = MediaCandidateMessage | ClearMediaCandidatesMessage;
