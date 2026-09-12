/**
 * Tareas en Background (Placeholder)
 *
 * Workers asíncronos, cron jobs, colas de procesamiento
 * (Trigger.dev, BullMQ o setTimeout/in-memory queue).
 */

export interface JobPayload {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

export async function dispatchJob(job: JobPayload) {
  console.log(`[Jobs Placeholder] Dispatching job ${job.id} (${job.type})`);
  return { queued: true, jobId: job.id };
}
