// Performance profiles. "low" targets old machines (e.g. Core i5 3rd gen / 4 GB RAM):
// smaller screenshots, fewer mouse-move events, longer minimum loop interval.

export const PROFILES = {
  low: {
    name: 'low',
    captureMaxWidth: 1024,
    jpegQuality: 0.55,
    thumbSize: 24,
    mouseStepPx: 30, // one mousemove event per ~N px of travel
    mouseMaxSteps: 24,
    minLoopSec: 6,
    scrollChunkPx: 120,
  },
  high: {
    name: 'high',
    captureMaxWidth: 1568, // ~Claude's preferred long edge; bigger buys nothing
    jpegQuality: 0.8,
    thumbSize: 48,
    mouseStepPx: 10,
    mouseMaxSteps: 80,
    minLoopSec: 2,
    scrollChunkPx: 60,
  },
};

export function detectHardware() {
  return {
    cores: navigator.hardwareConcurrency || 4,
    memoryGb: navigator.deviceMemory || 4, // Chrome caps this at 8
  };
}

export function resolveProfile(name) {
  if (name === 'low' || name === 'high') return PROFILES[name];
  const { cores, memoryGb } = detectHardware();
  return cores <= 4 || memoryGb <= 4 ? PROFILES.low : PROFILES.high;
}
