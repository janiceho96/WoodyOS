CREATE TABLE departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','archived')),
  display_order INTEGER NOT NULL DEFAULT 0,
  manager_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX departments_active_name_idx
  ON departments(workspace_id,lower(name))
  WHERE status='active';

CREATE TABLE department_memberships (
  department_id UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  membership_type TEXT NOT NULL CHECK(membership_type IN ('primary','shared')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(department_id,agent_id)
);

CREATE UNIQUE INDEX department_memberships_one_primary_idx
  ON department_memberships(agent_id)
  WHERE membership_type='primary';

CREATE TABLE workspace_org_settings (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  executive_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

WITH legacy_teams AS (
  SELECT team.*,
         ROW_NUMBER() OVER (
           PARTITION BY team.workspace_id,lower(team.name)
           ORDER BY team.id
         ) AS active_name_position
  FROM agent_teams team
),
legacy_team_managers AS (
  SELECT team_id,
         CASE
           WHEN COUNT(DISTINCT manager_agent_id)
             FILTER (WHERE manager_agent_id IS NOT NULL) = 1
           THEN (ARRAY_AGG(DISTINCT manager_agent_id)
             FILTER (WHERE manager_agent_id IS NOT NULL))[1]
           ELSE NULL
         END AS manager_agent_id
  FROM team_memberships
  GROUP BY team_id
)
INSERT INTO departments(id,workspace_id,name,description,manager_agent_id)
SELECT team.id,
       team.workspace_id,
       CASE
         WHEN team.active_name_position=1 THEN team.name
         ELSE team.name || ' (' || team.id::text || ')'
       END,
       team.description,
       manager.manager_agent_id
FROM legacy_teams team
LEFT JOIN legacy_team_managers manager ON manager.team_id=team.id
ON CONFLICT(id) DO NOTHING;

WITH membership_counts AS (
  SELECT agent_id,count(*) AS team_count
  FROM team_memberships
  GROUP BY agent_id
)
INSERT INTO department_memberships(department_id,agent_id,membership_type)
SELECT tm.team_id,
       tm.agent_id,
       CASE WHEN mc.team_count=1 THEN 'primary' ELSE 'shared' END
FROM team_memberships tm
JOIN membership_counts mc ON mc.agent_id=tm.agent_id
ON CONFLICT(department_id,agent_id) DO NOTHING;
