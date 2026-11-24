export function sum(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

export function mean(xs: number[]): number {
  return xs.length ? sum(xs) / xs.length : NaN;
}

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export const median = (xs: number[]) => quantile(xs, 0.5);

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
}

/** Ağırlıklı medyan (ağırlık = cüzdan beceri skoru gibi) */
export function weightedQuantile(values: number[], weights: number[], q: number): number {
  const pairs = values
    .map((v, i) => [v, Math.max(0, weights[i] ?? 0)] as const)
    .filter(([v]) => Number.isFinite(v))
    .sort((a, b) => a[0] - b[0]);
  const total = sum(pairs.map((p) => p[1]));
  if (!pairs.length) return NaN;
  if (total <= 0) return quantile(pairs.map((p) => p[0]), q);
  let acc = 0;
  for (const [v, w] of pairs) {
    acc += w;
    if (acc / total >= q) return v;
  }
  return pairs[pairs.length - 1]![0];
}

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function round(x: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** Değerleri en yakın "güzel" kademeye yuvarlar: 1.5x, 2x, 3x gibi */
export function niceMultiple(x: number): number {
  const steps = [1.2, 1.3, 1.5, 1.75, 2, 2.5, 3, 4, 5, 7.5, 10, 15, 20, 30, 50, 100];
  let best = steps[0]!;
  for (const s of steps) if (Math.abs(Math.log(s / x)) < Math.abs(Math.log(best / x))) best = s;
  return best;
}
