ALTER TABLE agents
  ADD CONSTRAINT agents_id_workspace_id_key UNIQUE(id,workspace_id);

CREATE TABLE departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','archived')),
  display_order INTEGER NOT NULL DEFAULT 0,
  manager_agent_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(id,workspace_id),
  FOREIGN KEY(manager_agent_id,workspace_id)
    REFERENCES agents(id,workspace_id)
    ON DELETE SET NULL (manager_agent_id)
);

CREATE UNIQUE INDEX departments_active_name_idx
  ON departments(workspace_id,lower(name))
  WHERE status='active';

CREATE TABLE department_memberships (
  department_id UUID NOT NULL,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL,
  membership_type TEXT NOT NULL CHECK(membership_type IN ('primary','shared')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(department_id,agent_id),
  FOREIGN KEY(department_id,workspace_id)
    REFERENCES departments(id,workspace_id)
    ON DELETE CASCADE,
  FOREIGN KEY(agent_id,workspace_id)
    REFERENCES agents(id,workspace_id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX department_memberships_one_primary_idx
  ON department_memberships(agent_id)
  WHERE membership_type='primary';

CREATE TABLE workspace_org_settings (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  executive_agent_id UUID,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(executive_agent_id,workspace_id)
    REFERENCES agents(id,workspace_id)
    ON DELETE SET NULL (executive_agent_id)
);

DO $$
DECLARE
  legacy_team RECORD;
  candidate_name TEXT;
  candidate_suffix INTEGER;
BEGIN
  FOR legacy_team IN
    SELECT team.id,
           team.workspace_id,
           team.name,
           team.description,
           (
             SELECT CASE
               WHEN COUNT(DISTINCT membership.manager_agent_id) = 1
               THEN (ARRAY_AGG(DISTINCT membership.manager_agent_id))[1]
               ELSE NULL
             END
             FROM team_memberships membership
             JOIN agents manager
               ON manager.id=membership.manager_agent_id
              AND manager.workspace_id=team.workspace_id
             WHERE membership.team_id=team.id
           ) AS manager_agent_id
    FROM agent_teams team
    ORDER BY team.workspace_id,team.id
  LOOP
    candidate_name := legacy_team.name;
    candidate_suffix := 1;
    WHILE EXISTS (
      SELECT 1
      FROM departments department
      WHERE department.workspace_id=legacy_team.workspace_id
        AND department.status='active'
        AND lower(department.name)=lower(candidate_name)
    ) LOOP
      candidate_name := legacy_team.name
        || ' (legacy department ' || legacy_team.id::text
        || ' #' || candidate_suffix::text || ')';
      candidate_suffix := candidate_suffix + 1;
    END LOOP;

    INSERT INTO departments(id,workspace_id,name,description,manager_agent_id)
    VALUES(
      legacy_team.id,
      legacy_team.workspace_id,
      candidate_name,
      legacy_team.description,
      legacy_team.manager_agent_id
    )
    ON CONFLICT(id) DO NOTHING;
  END LOOP;
END;
$$;

WITH valid_team_memberships AS (
  SELECT team.id AS department_id,
         team.workspace_id,
         membership.agent_id
  FROM agent_teams team
  JOIN team_memberships membership ON membership.team_id=team.id
  JOIN agents agent
    ON agent.id=membership.agent_id
   AND agent.workspace_id=team.workspace_id
),
membership_counts AS (
  SELECT agent_id,count(*) AS team_count
  FROM valid_team_memberships
  GROUP BY agent_id
)
INSERT INTO department_memberships(department_id,workspace_id,agent_id,membership_type)
SELECT membership.department_id,
       membership.workspace_id,
       membership.agent_id,
       CASE WHEN counts.team_count=1 THEN 'primary' ELSE 'shared' END
FROM valid_team_memberships membership
JOIN membership_counts counts ON counts.agent_id=membership.agent_id
ON CONFLICT(department_id,agent_id) DO NOTHING;
