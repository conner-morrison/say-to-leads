// The day schedule: 5–6 hours of work split into 2–5 intervals, made when the extension wakes up on a
// new day (or by the Schedule button in Settings). Times are local "HH:MM" strings.
// Stored in chrome.storage.local:
//   schedule     – { day: 'YYYY-MM-DD', intervals: [{start, end}], skipped: [i], source: 'auto' | 'manual', at }
//   nextSchedule – { day, intervals } a human made while the day was over; it becomes that day's schedule.

import { rint, rnd } from './human.js';

export const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const tomorrowKey = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return dayKey(d);
};

export const toMin = (s) => {
  const [a, b] = String(s || '').split(':').map(Number);
  return (a || 0) * 60 + (b || 0);
};
export const toHHMM = (m) => {
  m = Math.max(0, Math.min(Math.round(m), 24 * 60 - 1));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
export const nowMin = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
};

// Random intervals for a day. fromMin = the earliest start (now when made on waking up, the day
// start for another day). The gaps shrink when the day is too short to hold them; the work total never does,
// unless it would run past midnight.
export function generate(cfg, fromMin) {
  const total = Math.round(rnd(cfg.hoursMin, cfg.hoursMax) * 60);
  const parts = rint(Math.max(1, cfg.partsMin), Math.max(cfg.partsMin, cfg.partsMax));
  // Random split of the total, every part at least 25 min.
  const w = Array.from({ length: parts }, () => rnd(0.6, 1.4));
  const sw = w.reduce((a, b) => a + b, 0);
  const min = 25;
  let lens = w.map((x) => min + ((total - min * parts) * x) / sw);
  lens = lens.map(Math.round);
  lens[lens.length - 1] += total - lens.reduce((a, b) => a + b, 0);

  const start = Math.max(fromMin, toMin(cfg.dayStart)) + rnd(2, 15);
  const end = Math.max(toMin(cfg.dayEnd), start + total);
  let gaps = Array.from({ length: parts - 1 }, () => rnd(cfg.gapMinMin, cfg.gapMaxMin));
  const room = Math.min(end, 24 * 60 - 1) - start - total;
  const sg = gaps.reduce((a, b) => a + b, 0);
  if (sg > room) gaps = gaps.map((g) => Math.max(5, (g * Math.max(room, 0)) / sg));

  const out = [];
  let t = start;
  for (let i = 0; i < parts; i++) {
    const s = Math.round(t);
    const e = Math.round(t + lens[i]);
    if (s >= 24 * 60 - 1) break;
    out.push({ start: toHHMM(s), end: toHHMM(e) });
    t += lens[i] + (gaps[i] || 0);
  }
  return out;
}

// Sorted, valid intervals (end after start, no overlaps) from what a human typed.
export function clean(intervals) {
  const list = (intervals || [])
    .map((iv) => ({ start: String(iv.start || ''), end: String(iv.end || '') }))
    .filter((iv) => /^\d\d:\d\d$/.test(iv.start) && /^\d\d:\d\d$/.test(iv.end))
    .sort((a, b) => toMin(a.start) - toMin(b.start));
  for (const [i, iv] of list.entries()) {
    if (toMin(iv.end) <= toMin(iv.start)) throw new Error(`Interval ${i + 1} (${iv.start}–${iv.end}) ends before it starts.`);
    if (i && toMin(iv.start) < toMin(list[i - 1].end)) throw new Error(`Intervals ${i} and ${i + 1} overlap.`);
  }
  return list;
}

export const totalMin = (intervals) => (intervals || []).reduce((a, iv) => a + toMin(iv.end) - toMin(iv.start), 0);

// Index of the interval holding `m` (minutes since midnight), or -1.
export const slotAt = (sched, m = nowMin()) =>
  (sched?.intervals || []).findIndex((iv, i) => !sched.skipped?.includes(i) && m >= toMin(iv.start) && m < toMin(iv.end));

// Index of the interval holding `m`, skipped or not, or -1.
export const intervalAt = (intervals, m = nowMin()) =>
  (intervals || []).findIndex((iv) => m >= toMin(iv.start) && m < toMin(iv.end));

// The next interval that has not started yet.
export const nextSlot = (sched, m = nowMin()) =>
  (sched?.intervals || []).find((iv, i) => !sched.skipped?.includes(i) && toMin(iv.start) > m) || null;

// The day's work is over: the last interval has ended (or there is none).
export const dayOver = (sched, m = nowMin()) => !(sched?.intervals || []).some((iv) => toMin(iv.end) > m);
