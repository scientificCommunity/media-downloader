export interface DashSegmentRef {
  key: string;
  number: number;
  time: number;
  duration: number;
  url: string;
}

export interface DashRepresentation {
  id: string;
  kind: 'video' | 'audio';
  bandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
  mimeType?: string;
  baseUrl: string;
  initializationUrl: string;
  mediaTemplate: string;
  timescale: number;
  startNumber: number;
  duration?: number;
  timeline?: Array<{ t?: number; d: number; r?: number }>;
}

export interface DashProbe {
  sourceUrl: string;
  isLive: boolean;
  minimumUpdatePeriod: number;
  timeShiftBufferDepth?: number;
  availabilityStartTime?: number;
  periodStart: number;
  videoRepresentations: DashRepresentation[];
  audioRepresentations: DashRepresentation[];
  encrypted: boolean;
}
