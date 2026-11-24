/** Tekrarlanabilir sonuçlar için basit tohumlu RNG (mulberry32) */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dist2 = (a: number[], b: number[]) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i]! - b[i]!) ** 2;
  return s;
};

export interface KMeansResult {
  k: number;
  labels: number[];
  centroids: number[][];
  inertia: number;
}

/** k-means++ başlatmalı k-means */
export function kmeans(data: number[][], k: number, seed = 42, maxIter = 100): KMeansResult {
  const rand = rng(seed);
  const n = data.length;
  const centroids: number[][] = [data[Math.floor(rand() * n)]!.slice()];
  while (centroids.length < k) {
    const d = data.map((p) => Math.min(...centroids.map((c) => dist2(p, c))));
    const total = d.reduce((a, b) => a + b, 0);
    let r = rand() * total;
    let idx = 0;
    for (; idx < n - 1; idx++) {
      r -= d[idx]!;
      if (r <= 0) break;
    }
    centroids.push(data[idx]!.slice());
  }
  const labels = new Array<number>(n).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const dd = dist2(data[i]!, centroids[c]!);
        if (dd < bestD) {
          bestD = dd;
          best = c;
        }
      }
      if (labels[i] !== best) {
        labels[i] = best;
        changed = true;
      }
    }
    for (let c = 0; c < k; c++) {
      const members = data.filter((_, i) => labels[i] === c);
      if (!members.length) continue;
      centroids[c] = members[0]!.map((_, j) => members.reduce((s, m) => s + m[j]!, 0) / members.length);
    }
    if (!changed && iter > 0) break;
  }
  const inertia = data.reduce((s, p, i) => s + dist2(p, centroids[labels[i]!]!), 0);
  return { k, labels, centroids, inertia };
}

export function silhouette(data: number[][], labels: number[]): number {
  const n = data.length;
  const ks = [...new Set(labels)];
  if (ks.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const own = labels[i]!;
    const meanTo = (c: number) => {
      const idx = data.map((_, j) => j).filter((j) => labels[j] === c && j !== i);
      if (!idx.length) return 0;
      return idx.reduce((s, j) => s + Math.sqrt(dist2(data[i]!, data[j]!)), 0) / idx.length;
    };
    const a = meanTo(own);
    const b = Math.min(...ks.filter((c) => c !== own).map(meanTo));
    total += b === 0 && a === 0 ? 0 : (b - a) / Math.max(a, b);
  }
  return total / n;
}

/** Silüet skoruna göre en iyi k'yi seçer (2..maxK). Az veri varsa tek küme. */
export function autoKMeans(data: number[][], maxK = 6, seed = 42): KMeansResult & { silhouette: number } {
  if (data.length < 4) {
    return { ...kmeans(data, 1, seed), silhouette: 0 };
  }
  let best: (KMeansResult & { silhouette: number }) | null = null;
  const upper = Math.min(maxK, Math.floor(data.length / 2));
  for (let k = 2; k <= upper; k++) {
    const r = kmeans(data, k, seed);
    const s = silhouette(data, r.labels);
    if (!best || s > best.silhouette) best = { ...r, silhouette: s };
  }
  // silüet çok düşükse gruplar anlamsız: tek küme
  if (!best || best.silhouette < 0.15) return { ...kmeans(data, 1, seed), silhouette: best?.silhouette ?? 0 };
  return best;
}

/** Sütun bazında z-skor normalizasyonu; NaN değerler sütun medyanıyla doldurulur */
export function standardize(rows: number[][]): number[][] {
  if (!rows.length) return rows;
  const cols = rows[0]!.length;
  const out = rows.map((r) => r.slice());
  for (let j = 0; j < cols; j++) {
    const vals = out.map((r) => r[j]!).filter(Number.isFinite).sort((a, b) => a - b);
    const med = vals.length ? vals[Math.floor(vals.length / 2)]! : 0;
    for (const r of out) if (!Number.isFinite(r[j]!)) r[j] = med;
    const m = out.reduce((s, r) => s + r[j]!, 0) / out.length;
    const sd = Math.sqrt(out.reduce((s, r) => s + (r[j]! - m) ** 2, 0) / out.length) || 1;
    for (const r of out) r[j] = (r[j]! - m) / sd;
  }
  return out;
}
