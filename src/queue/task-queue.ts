import { createHash } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export const TASK_QUEUE = 'agent-tasks';
export const WORKFLOW_QUEUE = 'workflow-runs';
export const KNOWLEDGE_QUEUE = 'knowledge-ingestion';
export const ARTIFACT_QUEUE = 'artifact-generation';
let queue: Queue<{ taskId: string }> | undefined;
let workflowQueue: Queue<{ workflowRunId: string }> | undefined;
let knowledgeQueue: Queue<{ documentId: string }> | undefined;
let artifactQueue: Queue<{ artifactId: string }> | undefined;

export function queueJobId(phaseId: string) {
  return createHash('sha256').update(phaseId).digest('hex');
}

function taskQueue() {
  if (!queue) {
    const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
    queue = new Queue<{ taskId: string }>(TASK_QUEUE, { connection });
  }
  return queue;
}

export async function enqueueTask(taskId: string, phaseId = taskId) {
  await taskQueue().add('execute', { taskId }, { jobId: queueJobId(phaseId), removeOnComplete: 1000, removeOnFail: 1000, attempts: 3, backoff: { type: 'exponential', delay: 1000 } });
}

export async function enqueueWorkflowRun(workflowRunId: string, phaseId = workflowRunId, delay = 0) {
  if (!workflowQueue) {
    const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
    workflowQueue = new Queue<{ workflowRunId: string }>(WORKFLOW_QUEUE, { connection });
  }
  await workflowQueue.add('execute', { workflowRunId }, { jobId: queueJobId(phaseId), delay, removeOnComplete: 1000, removeOnFail: 1000, attempts: 3, backoff: { type: 'exponential', delay: 1000 } });
}

export async function enqueueKnowledgeDocument(documentId: string) {
  if (!knowledgeQueue) {
    const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
    knowledgeQueue = new Queue<{ documentId: string }>(KNOWLEDGE_QUEUE, { connection });
  }
  await knowledgeQueue.add('ingest', { documentId }, { jobId: queueJobId(documentId), removeOnComplete: 1000, removeOnFail: 1000, attempts: 3, backoff: { type: 'exponential', delay: 1000 } });
}

export async function enqueueArtifact(artifactId: string, phaseId = artifactId) {
  if (!artifactQueue) {
    const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
    artifactQueue = new Queue<{ artifactId: string }>(ARTIFACT_QUEUE, { connection });
  }
  await artifactQueue.add('generate', { artifactId }, { jobId: queueJobId(phaseId), removeOnComplete: 1000, removeOnFail: 1000, attempts: 3, backoff: { type: 'exponential', delay: 1500 } });
}

export async function closeQueues() {
  await Promise.all([queue?.close(), workflowQueue?.close(), knowledgeQueue?.close(), artifactQueue?.close()].filter((item): item is Promise<void> => Boolean(item)));
  queue = undefined;
  workflowQueue = undefined;
  knowledgeQueue = undefined;
  artifactQueue = undefined;
}
