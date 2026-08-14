import { parseDashDuration } from './dash-duration';
import { dashBase, dashChildren } from './dash-xml';

export interface DashPeriodMeta {
  period: Element;
  baseUrl: string;
  start: number;
}

export function parseSingleDashPeriod(mpd: Element, sourceUrl: string): DashPeriodMeta {
  const periods = dashChildren(mpd, 'Period');
  if (periods.length !== 1) {
    throw new Error('Only single-period DASH live streams are supported.');
  }
  const period = periods[0];
  const rootBase = dashBase(new URL('.', sourceUrl).href, mpd);
  return {
    period,
    baseUrl: dashBase(rootBase, period),
    start: parseDashDuration(period.getAttribute('start')) ?? 0
  };
}
