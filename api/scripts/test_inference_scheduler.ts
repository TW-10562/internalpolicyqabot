import assert from 'node:assert/strict';
import {
  cancelScheduledInference,
  consumeInferenceMetrics,
  getInferenceSchedulerSnapshot,
  InferenceCancelledError,
  scheduleInference,
} from '@/service/inferenceScheduler';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const baseline = getInferenceSchedulerSnapshot();
  let active = 0;
  let peakActive = 0;

  const jobs = Array.from({ length: 8 }, (_, index) => scheduleInference({
    requestId: `req-${index}`,
    traceId: `trace-${index}`,
    taskId: `task-${Math.floor(index / 2)}`,
    outputId: index + 1,
    userId: (index % 4) + 1,
    userName: `user-${(index % 4) + 1}`,
    maxTokens: index % 2 === 0 ? 256 : 768,
    timeoutMs: 5000,
    work: async ({ signal }) => {
      if (signal.aborted) throw signal.reason;
      active += 1;
      peakActive = Math.max(peakActive, active);
      await sleep(index % 2 === 0 ? 120 : 220);
      active -= 1;
      return `ok-${index}`;
    },
  }));

  const cancelled = scheduleInference({
    requestId: 'req-cancel',
    traceId: 'trace-cancel',
    taskId: 'task-cancel',
    outputId: 999,
    userId: 77,
    userName: 'user-cancel',
    maxTokens: 512,
    timeoutMs: 5000,
    work: async ({ signal }) => {
      if (signal.aborted) throw signal.reason;
      await sleep(500);
      return 'should-not-complete';
    },
  });

  await sleep(25);
  const cancelledAccepted = cancelScheduledInference(999, 'test_cancel');
  assert.equal(cancelledAccepted, true);

  const settled = await Promise.allSettled([...jobs, cancelled]);
  const completed = settled.filter((item) => item.status === 'fulfilled');
  const rejected = settled.filter((item) => item.status === 'rejected');

  assert.equal(completed.length, 8);
  assert.equal(rejected.length, 1);
  assert.ok(peakActive <= baseline.maxInFlight, `peakActive=${peakActive} maxInFlight=${baseline.maxInFlight}`);
  assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof InferenceCancelledError);

  const sampleMetrics = consumeInferenceMetrics(1);
  assert.ok(sampleMetrics);
  assert.ok(Number(sampleMetrics?.queueMs || 0) >= 0);
  assert.ok(Number(sampleMetrics?.generationMs || 0) >= 0);

  const finalSnapshot = getInferenceSchedulerSnapshot();
  assert.ok(finalSnapshot.finishedCount >= baseline.finishedCount + 8);
  assert.ok(finalSnapshot.cancellationCount >= baseline.cancellationCount + 1);

  console.log(JSON.stringify({
    ok: true,
    peakActive,
    maxInFlight: baseline.maxInFlight,
    finalSnapshot,
    sampleMetrics,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
