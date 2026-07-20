import type { FastifyInstance } from 'fastify';
import { query } from '../db/client.js';
import { asyncRoute } from '../lib/http.js';
export async function analyticsRoutes(app: FastifyInstance) {
  app.get('/overview', { preHandler: app.authenticate }, asyncRoute(async (request) => {
    const workspaceId = request.user.workspaceId;
    const [agents, tasks, costs, satisfaction, activity] = await Promise.all([
      query<{ active_agents: string }>("SELECT count(*) FILTER (WHERE status='active')::text active_agents FROM agents WHERE workspace_id=$1", [workspaceId]),
      query<{ running_tasks: string; completed_tasks: string; failed_tasks: string; success_rate: string; average_duration_ms: string | null }>("SELECT count(*) FILTER (WHERE status IN ('queued','running','awaiting_approval'))::text running_tasks,count(*) FILTER (WHERE status='completed')::text completed_tasks,count(*) FILTER (WHERE status='failed')::text failed_tasks,COALESCE(round(100.0*count(*) FILTER (WHERE status='completed')/NULLIF(count(*) FILTER (WHERE status IN ('completed','failed')),0),2),0)::text success_rate,round(avg(duration_ms) FILTER (WHERE status='completed'))::text average_duration_ms FROM tasks WHERE workspace_id=$1", [workspaceId]),
      query<{ token_input: string; token_output: string; api_cost_usd: string }>('SELECT coalesce(sum(token_input),0)::text token_input,coalesce(sum(token_output),0)::text token_output,coalesce(sum(estimated_cost_usd),0)::text api_cost_usd FROM tasks WHERE workspace_id=$1', [workspaceId]),
      query<{ average_rating: string; ratings_count: string }>('SELECT coalesce(round(avg(rating)::numeric,2),0)::text average_rating,count(*)::text ratings_count FROM task_feedback WHERE workspace_id=$1', [workspaceId]),
      query('SELECT e.created_at,e.event_type,e.message,t.title,a.name agent_name FROM task_events e JOIN tasks t ON t.id=e.task_id JOIN agents a ON a.id=t.agent_id WHERE e.workspace_id=$1 ORDER BY e.created_at DESC LIMIT 20', [workspaceId]),
    ]);
    return { agents: agents.rows[0], tasks: tasks.rows[0], usage: costs.rows[0], satisfaction: satisfaction.rows[0], activity: activity.rows };
  }));
}
