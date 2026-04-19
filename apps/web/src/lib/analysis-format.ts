export function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(2)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}k`;
  }
  return String(n);
}

export function fmtCost(usd: number | null): string {
  if (usd === null) {
    return '—';
  }
  if (usd < 0.001) {
    return `$${(usd * 1000).toFixed(3)}m`;
  }
  return `$${usd.toFixed(4)}`;
}

export function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

export function isAdvisorModelKey(name: string): boolean {
  return name.startsWith('advisor:');
}

export function modelColor(name: string): string {
  if (isAdvisorModelKey(name)) return '#ce93d8';
  const lower = name.toLowerCase();
  if (lower.includes('opus')) return '#a78bfa';
  if (lower.includes('sonnet')) return '#60a5fa';
  if (lower.includes('haiku')) return '#34d399';
  return '#94a3b8';
}

export function formatModelName(name: string): string {
  if (isAdvisorModelKey(name)) {
    const inner = name.slice('advisor:'.length);
    const m = inner.match(/(?:claude-)?(opus|sonnet|haiku)-(\d+)-(\d+)/i);
    if (m) {
      const model = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
      return `Advisor (${model} ${m[2]}.${m[3]})`;
    }
    return `Advisor (${inner})`;
  }
  const m = name.match(/(?:claude-)?(opus|sonnet|haiku)-(\d+)-(\d+)/i);
  if (m) {
    const model = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    return `${model} ${m[2]}.${m[3]}`;
  }
  return name;
}
