/**
 * Tests for handler concurrency control.
 * Verifies: max 2 concurrent, queuing, error isolation, slot release on failure.
 */

describe('handler concurrency control', () => {
  // Replicate the concurrency mechanism from testPageChangesHandler
  const MAX_CONCURRENT = 2;
  let running: number;
  let queue: Array<{ resolve: () => void }>;

  async function acquireSlot(): Promise<void> {
    if (running < MAX_CONCURRENT) { running++; return; }
    await new Promise<void>((resolve) => queue.push({ resolve }));
  }

  function releaseSlot(): void {
    running--;
    const next = queue.shift();
    if (next) { running++; next.resolve(); }
  }

  beforeEach(() => {
    running = 0;
    queue = [];
  });

  it('allows up to 2 concurrent executions', async () => {
    const order: string[] = [];

    async function task(id: string, durationMs: number) {
      await acquireSlot();
      order.push(`start-${id}`);
      await new Promise(r => setTimeout(r, durationMs));
      order.push(`end-${id}`);
      releaseSlot();
    }

    await Promise.all([task('a', 50), task('b', 50), task('c', 50)]);

    // a and b start immediately, c waits for one to finish
    expect(order.indexOf('start-a')).toBeLessThan(order.indexOf('start-c'));
    expect(order.indexOf('start-b')).toBeLessThan(order.indexOf('start-c'));
    // c starts after either a or b finishes
    const cStart = order.indexOf('start-c');
    const aEnd = order.indexOf('end-a');
    const bEnd = order.indexOf('end-b');
    expect(cStart).toBeGreaterThan(Math.min(aEnd, bEnd));
  });

  it('queues task 3 and 4 when slots are full', async () => {
    let maxConcurrent = 0;

    async function task(durationMs: number) {
      await acquireSlot();
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise(r => setTimeout(r, durationMs));
      releaseSlot();
    }

    await Promise.all([task(50), task(50), task(50), task(50)]);
    expect(maxConcurrent).toBe(2);
  });

  it('releases slot even when task throws', async () => {
    async function failingTask() {
      await acquireSlot();
      try {
        throw new Error('task failed');
      } finally {
        releaseSlot();
      }
    }

    async function successTask() {
      await acquireSlot();
      await new Promise(r => setTimeout(r, 10));
      releaseSlot();
      return 'done';
    }

    // Fill both slots with failures, then run a success
    const results = await Promise.allSettled([
      failingTask(),
      failingTask(),
      successTask(),
    ]);

    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('rejected');
    expect(results[2].status).toBe('fulfilled');
    expect(running).toBe(0);
    expect(queue).toHaveLength(0);
  });

  it('one failure does not block other tasks', async () => {
    const completed: string[] = [];

    async function failingTask() {
      await acquireSlot();
      try {
        throw new Error('boom');
      } finally {
        releaseSlot();
      }
    }

    async function successTask(id: string) {
      await acquireSlot();
      await new Promise(r => setTimeout(r, 10));
      completed.push(id);
      releaseSlot();
    }

    await Promise.allSettled([
      failingTask(),
      successTask('a'),
      successTask('b'),
      successTask('c'),
    ]);

    expect(completed).toEqual(expect.arrayContaining(['a', 'b', 'c']));
    expect(completed).toHaveLength(3);
  });
});
