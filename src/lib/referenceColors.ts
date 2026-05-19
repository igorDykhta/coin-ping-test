/**
 * Stable color palette for highlighting saved reference recordings on the
 * chart. The same color is reused everywhere (sidebar dot + chart circle) so
 * users can map a chart marker back to its preset at a glance.
 */
const PALETTE = [
  "hsl(45, 95%, 60%)", // amber
  "hsl(340, 90%, 65%)", // pink
  "hsl(140, 75%, 55%)", // green
  "hsl(20, 90%, 65%)", // orange
  "hsl(280, 80%, 70%)", // purple
  "hsl(180, 85%, 60%)", // cyan
  "hsl(0, 90%, 65%)", // red
  "hsl(60, 90%, 60%)", // yellow
] as const;

export function getReferenceColor(id: number): string {
  if (!Number.isFinite(id)) return PALETTE[0];
  const n = Math.abs(Math.trunc(id));
  return PALETTE[n % PALETTE.length];
}
