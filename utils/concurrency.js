// Small shared helper for fan-out work over a list of async operations
// (e.g. one notification send per recipient) - a real performance issue:
// several call sites looped over a list of accounts/records awaiting one
// fully-sequential async call per item, each itself several DB round
// trips (and, for notify(), real email/SMS provider calls) deep. Fully
// sequential turns an announcement to a large recipient list into a
// multi-second-or-worse single request. Unbounded Promise.all instead
// risks opening far more concurrent DB connections/provider requests than
// the pool (or the provider's own rate limit) can actually handle at
// once. This runs a bounded number of items at a time - inline instead of
// pulling in a dependency for something this small.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

module.exports = { mapWithConcurrency };
