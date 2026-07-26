import { createHash } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { childTraceContext, createTraceContext, type TraceContext } from '../runtime/trace.js';

export const TASK_QUEUE = 'agent-tasks';
export const WORKFLOW_QUEUE = 'workflow-runs';
export const KNOWLEDGE_QUEUE = 'knowledge-ingestion';
export const ARTIFACT_QUEUE = 'artifact-generation';
export const FILE_QUEUE = 'file-processing';
export type TaskJobData = { taskId: string; traceId: string };
export type WorkflowJobData = { workflowRunId: string; traceId: string };
export type KnowledgeJobData = { documentId: string; trace: TraceContext };
export type ArtifactJobData = { artifactId: string; trace: TraceContext };
export type FileJobData = { fileId: string; trace: TraceContext };
let queue: Queue<TaskJobData> | undefined;
let workflowQueue: Queue<WorkflowJobData> | undefined;
let knowledgeQueue: Queue<KnowledgeJobData> | undefined;
let artifactQueue: Queue<ArtifactJobData> | undefined;
let fileQueue: Queue<FileJobData> | undefined;

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

export function knowledgeJobData(documentId: string, trace: TraceContext): KnowledgeJobData {
  return { documentId, trace };
}

export function artifactJobData(artifactId: string, trace: TraceContext): ArtifactJobData {
  return { artifactId, trace };
}

export function fileJobData(fileId: string, trace: TraceContext): FileJobData {
  return { fileId, trace };
}

export function taskQueueJobOptions(phaseId: string) {
  return {
    jobId: queueJobId(phaseId),
    removeOnComplete: 1_000,
    removeOnFail: 1_000,
    attempts: 1,
  };
}

export function workflowQueueJobOptions(phaseId: string, delay = 0) {
  return {
    ...taskQueueJobOptions(phaseId),
    delay,
  };
}

export function safeReentryQueueJobOptions(phaseId: string, backoffDelay: number) {
  return {
    jobId: queueJobId(phaseId),
    removeOnComplete: 1_000,
    removeOnFail: 1_000,
    attempts: 3,
    backoff: { type: 'exponential' as const, delay: backoffDelay },
  };
}

function standaloneOperationTrace(trace?: TraceContext) {
  return trace ?? childTraceContext(createTraceContext());
}

export async function enqueueTask(taskId: string, phaseId = taskId, traceId?: string) {
  if (!traceId) throw new Error('TRACE_CONTEXT_REQUIRED');
  await taskQueue().add('execute', taskJobData(taskId, traceId), taskQueueJobOptions(phaseId));
}

export async function enqueueWorkflowRun(workflowRunId: string, phaseId = workflowRunId, delay = 0, traceId?: string) {
  if (!traceId) throw new Error('TRACE_CONTEXT_REQUIRED');
  if (!workflowQueue) {
    const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
    workflowQueue = new Queue<WorkflowJobData>(WORKFLOW_QUEUE, { connection });
  }
  await workflowQueue.add('execute', workflowJobData(workflowRunId, traceId), workflowQueueJobOptions(phaseId, delay));
}

export async function enqueueKnowledgeDocument(documentId: string, trace?: TraceContext) {
  if (!knowledgeQueue) {
    const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
    knowledgeQueue = new Queue<KnowledgeJobData>(KNOWLEDGE_QUEUE, { connection });
  }
  await knowledgeQueue.add('ingest', knowledgeJobData(documentId, standaloneOperationTrace(trace)), safeReentryQueueJobOptions(documentId, 1_000));
}

export async function enqueueArtifact(artifactId: string, phaseId = artifactId, trace?: TraceContext) {
  if (!artifactQueue) {
    const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
    artifactQueue = new Queue<ArtifactJobData>(ARTIFACT_QUEUE, { connection });
  }
  await artifactQueue.add('generate', artifactJobData(artifactId, standaloneOperationTrace(trace)), safeReentryQueueJobOptions(phaseId, 1_500));
}

export async function enqueueFile(fileId: string, phaseId = fileId, trace?: TraceContext) {
  if (!fileQueue) {
    const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null });
    fileQueue = new Queue<FileJobData>(FILE_QUEUE, { connection });
  }
  await fileQueue.add('process', fileJobData(fileId, standaloneOperationTrace(trace)), safeReentryQueueJobOptions(phaseId, 1_500));
}

export async function closeQueues() {
  await Promise.all([queue?.close(), workflowQueue?.close(), knowledgeQueue?.close(), artifactQueue?.close(), fileQueue?.close()].filter((item): item is Promise<void> => Boolean(item)));
  queue = undefined;
  workflowQueue = undefined;
  knowledgeQueue = undefined;
  artifactQueue = undefined;
  fileQueue = undefined;
}
