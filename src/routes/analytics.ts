import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/client.js';
import { asyncRoute, parse } from '../lib/http.js';

const analyticsQuery = z.object({
  days: z.coerce.number().int().refine((value) => [1, 7, 30].includes(value), 'Range must be 1, 7, or 30 days').optional(),
});

async function analyticsQueryStep<T extends Record<string, unknown>>(name: string, sql: string, parameters: unknown[]) {
  try {
    return await query<T>(sql, parameters);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Analytics ${name} query failed: ${detail}`, { cause });
  }
}

export async function analyticsRoutes(app: FastifyInstance) {
  app.get('/overview', { preHandler: app.authenticate }, asyncRoute(async (request, reply) => {
    const input = parse(analyticsQuery, request.query, reply);
    if (!input) return;
    const workspaceId = request.user.workspaceId;
    const days = input.days;
    const rangeEnd = new Date();
    const rangeStart = days ? new Date(rangeEnd.getTime() - days * 86_400_000) : null;
    const parameters = rangeStart ? [workspaceId, rangeStart.toISOString()] : [workspaceId];
    const taskWindow = rangeStart ? ' AND created_at >= $2::timestamptz' : '';
    const feedbackWindow = rangeStart ? ' AND f.created_at >= $2::timestamptz' : '';
    const activityWindow = rangeStart ? ' AND e.created_at >= $2::timestamptz' : '';
    const [agents, tasks, costs, satisfaction, activity] = await Promise.all([
      query<{ active_agents: string }>("SELECT count(*) FILTER (WHERE status='active')::text active_agents FROM agents WHERE workspace_id=$1", [workspaceId]),
      query<{ running_tasks: string; completed_tasks: string; failed_tasks: string; success_rate: string; average_duration_ms: string | null }>(`SELECT count(*) FILTER (WHERE status IN ('queued','running','awaiting_approval'))::text running_tasks,count(*) FILTER (WHERE status='completed')::text completed_tasks,count(*) FILTER (WHERE status='failed')::text failed_tasks,COALESCE(round(100.0*count(*) FILTER (WHERE status='completed')/NULLIF(count(*) FILTER (WHERE status IN ('completed','failed')),0),2),0)::text success_rate,round(avg(duration_ms) FILTER (WHERE status='completed'))::text average_duration_ms FROM tasks WHERE workspace_id=$1${taskWindow}`, parameters),
      query<{ token_input: string; token_output: string; api_cost_usd: string }>(`SELECT coalesce(sum(token_input),0)::text token_input,coalesce(sum(token_output),0)::text token_output,coalesce(sum(estimated_cost_usd),0)::text api_cost_usd FROM tasks WHERE workspace_id=$1${taskWindow}`, parameters),
      query<{ average_rating: string; ratings_count: string }>(`SELECT coalesce(round(avg(f.rating)::numeric,2),0)::text average_rating,count(*)::text ratings_count FROM task_feedback f WHERE f.workspace_id=$1${feedbackWindow}`, parameters),
      query(`SELECT e.created_at,e.event_type,e.message,t.title,a.id agent_id,a.name agent_name,a.role agent_role,a.avatar_config agent_avatar FROM task_events e JOIN tasks t ON t.id=e.task_id JOIN agents a ON a.id=t.agent_id WHERE e.workspace_id=$1${activityWindow} ORDER BY e.created_at DESC LIMIT 20`, parameters),
    ]);

    const [daily, effectiveness] = days ? await Promise.all([
      analyticsQueryStep<{
        day: string; task_count: string; completed_tasks: string; failed_tasks: string;
        token_input: string; token_output: string; api_cost_usd: string;
      }>('daily', `SELECT to_char(date_trunc('day',created_at AT TIME ZONE 'UTC'),'YYYY-MM-DD') AS "day",
          count(*)::text task_count,
          count(*) FILTER (WHERE status='completed')::text completed_tasks,
          count(*) FILTER (WHERE status='failed')::text failed_tasks,
          coalesce(sum(token_input),0)::text token_input,
          coalesce(sum(token_output),0)::text token_output,
          coalesce(sum(estimated_cost_usd),0)::text api_cost_usd
        FROM tasks
        WHERE workspace_id=$1 AND created_at >= $2::timestamptz
        GROUP BY 1 ORDER BY 1`, parameters),
      analyticsQueryStep<{
        agent_id: string; agent_name: string; agent_role: string; agent_status: string; agent_avatar: Record<string, unknown>; total_tasks: string;
        completed_tasks: string; failed_tasks: string; success_rate: string;
        average_duration_ms: string | null; token_input: string; token_output: string; api_cost_usd: string;
      }>('agent effectiveness', `SELECT a.id agent_id,a.name agent_name,a.role agent_role,a.status agent_status,a.avatar_config agent_avatar,
          count(t.id)::text total_tasks,
          count(t.id) FILTER (WHERE t.status='completed')::text completed_tasks,
          count(t.id) FILTER (WHERE t.status='failed')::text failed_tasks,
          coalesce(round(100.0*count(t.id) FILTER (WHERE t.status='completed')/
            nullif(count(t.id) FILTER (WHERE t.status IN ('completed','failed')),0),2),0)::text success_rate,
          round(avg(t.duration_ms) FILTER (WHERE t.status='completed'))::text average_duration_ms,
          coalesce(sum(t.token_input),0)::text token_input,
          coalesce(sum(t.token_output),0)::text token_output,
          coalesce(sum(t.estimated_cost_usd),0)::text api_cost_usd
        FROM agents a
        LEFT JOIN tasks t ON t.agent_id=a.id AND t.workspace_id=$1
          AND t.created_at >= $2::timestamptz
        WHERE a.workspace_id=$1
        GROUP BY a.id,a.name,a.role,a.status,a.avatar_config
        ORDER BY count(t.id) DESC,a.name`, parameters),
    ]) : [{ rows: [] }, { rows: [] }];

    return {
      agents: agents.rows[0], tasks: tasks.rows[0], usage: costs.rows[0],
      satisfaction: satisfaction.rows[0], activity: activity.rows,
      range: days && rangeStart ? { days, start: rangeStart.toISOString(), end: rangeEnd.toISOString(), timezone: 'UTC' } : null,
      daily: daily.rows,
      agent_effectiveness: effectiveness.rows,
    };
  }));
}
