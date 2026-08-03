/** `HH:mm:ss`, optionally with milliseconds — what Angular's DatePipe did. */
export function fmtTime(ms: number, millis = false): string {
  const date = new Date(ms);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  const base = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

  return millis ? `${base}.${pad(date.getMilliseconds(), 3)}` : base;
}
