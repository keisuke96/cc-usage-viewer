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

export function modelColor(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('opus')) return '#a78bfa';
  if (lower.includes('sonnet')) return '#60a5fa';
  if (lower.includes('haiku')) return '#34d399';
  return '#94a3b8';
}

export function formatModelName(name: string): string {
  const m = name.match(/(?:claude-)?(opus|sonnet|haiku)-(\d+)-(\d+)/i);
  if (m) {
    const model = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    return `${model} ${m[2]}.${m[3]}`;
  }
  return name;
}
