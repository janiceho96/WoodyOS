import { createHash } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export const TASK_QUEUE = 'agent-tasks';
export const WORKFLOW_QUEUE = 'workflow-runs';
export const KNOWLEDGE_QUEUE = 'knowledge-ingestion';
export const ARTIFACT_QUEUE = 'artifact-generation';
export const FILE_QUEUE = 'file-processing';
export type TaskJobData = { taskId: string; traceId: string };
export type WorkflowJobData = { workflowRunId: string; traceId: string };
let queue: Queue<TaskJobData> | undefined;
let workflowQueue: Queue<WorkflowJobData> | undefined;
let knowledgeQueue: Queue<{ documentId: string }> | undefined;
let artifactQueue: Queue<{ artifactId: string }> | undefined;
let fileQueue: Queue<{ fileId: string }> | undefined;

export function queueJobId(phaseId: string) {
  return createHash('sha256').update(phaseId).digest('hex');
}

function taskQueue() {
  if (!queue) {
    const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
    queue = new Queue<TaskJobData>(TASK_QUEUE, { connection });
  }
  return queue;
}

export function taskJobData(taskId: string, traceId: string): TaskJobData {
  return { taskId, traceId };
}

export function workflowJobData(workflowRunId: string, traceId: string): WorkflowJobData {
  return { workflowRunId, traceId };
}

export async function enqueueTask(taskId: string, phaseId = taskId, traceId?: string) {
  if (!traceId) throw new Error('TRACE_CONTEXT_REQUIRED');
  await taskQueue().add('execute', taskJobData(taskId, traceId), { jobId: queueJobId(phaseId), removeOnComplete: 1000, removeOnFail: 1000, attempts: 3, backoff: { type: 'exponential', delay: 1000 } });
}

export async function enqueueWorkflowRun(workflowRunId: string, phaseId = workflowRunId, delay = 0, traceId?: string) {
  if (!traceId) throw new Error('TRACE_CONTEXT_REQUIRED');
  if (!workflowQueue) {
    const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
    workflowQueue = new Queue<WorkflowJobData>(WORKFLOW_QUEUE, { connection });
  }
  await workflowQueue.add('execute', workflowJobData(workflowRunId, traceId), { jobId: queueJobId(phaseId), delay, removeOnComplete: 1000, removeOnFail: 1000, attempts: 3, backoff: { type: 'exponential', delay: 1000 } });
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

export async function enqueueFile(fileId: string, phaseId = fileId) {
  if (!fileQueue) {
    const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
    fileQueue = new Queue<{ fileId: string }>(FILE_QUEUE, { connection });
  }
  await fileQueue.add('process', { fileId }, {
    jobId: queueJobId(phaseId),
    removeOnComplete: 1000,
    removeOnFail: 1000,
    attempts: 3,
    backoff: { type: 'exponential', delay: 1_500 },
  });
}

export async function closeQueues() {
  await Promise.all([queue?.close(), workflowQueue?.close(), knowledgeQueue?.close(), artifactQueue?.close(), fileQueue?.close()].filter((item): item is Promise<void> => Boolean(item)));
  queue = undefined;
  workflowQueue = undefined;
  knowledgeQueue = undefined;
  artifactQueue = undefined;
  fileQueue = undefined;
}
