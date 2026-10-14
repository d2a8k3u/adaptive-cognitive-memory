export const HARNESS_MARKERS = [
  "<agent-message",
  "<system-reminder",
  "<task-notification",
  "[Subagent hand-back]",
  "Another Claude session sent a message:",
] as const;

export type HarnessMarker = (typeof HARNESS_MARKERS)[number];

export function harnessMarker(text: string): HarnessMarker | undefined {
  return HARNESS_MARKERS.find((marker) => text.includes(marker));
}
