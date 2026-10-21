export function finiteDuration(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

export function seekTarget(time: number, duration: number): number | null {
  const end = finiteDuration(duration);
  if (!Number.isFinite(time) || !end) return null;
  return Math.max(0, Math.min(time, end));
}
