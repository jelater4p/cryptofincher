/**
 * Basit token-bucket hız sınırlayıcı. Her API için ayrı örnek kullanılır.
 * İstekler sıraya girer, bucket boşsa bekler.
 */
export class RateLimiter {
  private tokens: number;
  private last = Date.now();
  private queue: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly capacity: number,
    /** saniyede eklenen token */
    private readonly refillPerSec: number,
  ) {
    this.tokens = capacity;
  }

  static perSecond(rps: number) {
    return new RateLimiter(Math.max(1, Math.floor(rps)), rps);
  }

  static perMinute(rpm: number) {
    return new RateLimiter(Math.max(1, Math.floor(rpm / 6)), rpm / 60);
  }

  private refill() {
    const now = Date.now();
    const elapsed = (now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
  }

  private drain() {
    this.refill();
    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      this.queue.shift()!();
    }
    if (this.queue.length > 0 && !this.timer) {
      const waitMs = Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.drain();
      }, Math.max(5, waitMs));
    }
  }

  acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.drain();
    });
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    return fn();
  }

  get pending() {
    return this.queue.length;
  }
}
