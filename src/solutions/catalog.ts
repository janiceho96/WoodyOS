import type { AgentSolution } from './schema.js';
import { parseAgentSolution } from './schema.js';

type Stage = { name: string; role: string; goal: string; focus: string };
type StarterSpec = {
  slug: string;
  name: string;
  category: string;
  difficulty: AgentSolution['difficulty'];
  description: string;
  inputs: AgentSolution['requiredInputs'];
  stages: [Stage, Stage, Stage, Stage];
  output: string;
  integrations: AgentSolution['recommendedIntegrations'];
  warnings?: string[];
};

function starter(spec: StarterSpec): AgentSolution {
  const agents = spec.stages.map((stage, index) => {
    const isFinal = index === spec.stages.length - 1;
    return {
      key: `agent_${index + 1}`,
      name: stage.name,
      role: stage.role,
      goal: stage.goal,
      instructions: [
        `Own this workflow stage: ${stage.focus}`,
        'Use the original request and all relevant upstream agent outputs supplied in the workflow input.',
        'Separate verified facts from assumptions. Never invent missing evidence.',
        'Do not perform external writes. Recommend an action for human review when a write would be useful.',
        isFinal
          ? `Return the final result as polished Markdown following this contract:\n${spec.output}`
          : 'Return structured Markdown with evidence, decisions, unresolved questions, and a concise handoff for the next specialist.',
      ].join('\n\n'),
      personality: isFinal ? 'Clear, decisive, editorial' : 'Analytical, careful, evidence-led',
      modelConfig: { temperature: isFinal ? 0.3 : 0.15, maxTokens: 4096, topP: 1 },
      capabilities: { webBrowser: false, codeInterpreter: false, knowledgeBase: true },
    };
  });
  const nodes: AgentSolution['workflow']['nodes'] = [
    { id: 'trigger', type: 'trigger', config: { event: 'manual' } },
    ...agents.map((agent, index) => ({
      id: `stage_${index + 1}`,
      type: 'agent' as const,
      agentKey: agent.key,
      config: { responsibility: spec.stages[index].focus, expectedOutput: index === agents.length - 1 ? spec.output : 'Evidence-led Markdown handoff' },
    })),
    { id: 'output', type: 'output', config: { fromNodeId: `stage_${agents.length}`, format: 'markdown' } },
  ];
  return parseAgentSolution({
    slug: spec.slug,
    version: 1,
    source: 'starter',
    name: spec.name,
    description: spec.description,
    category: spec.category,
    difficulty: spec.difficulty,
    estimatedModelCalls: agents.length,
    estimatedTokenRange: { minimum: 6_000, maximum: 32_000 },
    requiredInputs: spec.inputs,
    agents,
    team: {
      name: `${spec.name} Team`,
      description: `Specialist team installed by the ${spec.name} starter solution.`,
      managerAgentKey: agents.at(-1)!.key,
    },
    workflow: {
      name: spec.name,
      description: spec.description,
      nodes,
      edges: nodes.slice(0, -1).map((node, index) => ({ source: node.id, target: nodes[index + 1].id })),
    },
    expectedMarkdownOutput: spec.output,
    recommendedIntegrations: spec.integrations,
    requiredPermissions: spec.integrations.map((integration) => ({
      resource: integration.name,
      level: 'read',
      reason: integration.purpose,
      requiresConfirmation: false,
    })),
    humanApprovalRequirements: ['Require explicit confirmation before any suggested external write, message, upload, update, or destructive action.'],
    missingQuestions: [],
    warnings: spec.warnings ?? ['Review agent instructions and connector permissions before activating this solution.'],
  });
}

const notionRead = (purpose: string): AgentSolution['recommendedIntegrations'][number] => ({
  id: 'notion',
  name: 'Notion',
  purpose,
  required: false,
  permission: 'read',
  toolHints: ['search', 'fetch', 'query'],
});
const gmailRead = (purpose: string): AgentSolution['recommendedIntegrations'][number] => ({
  id: 'gmail',
  name: 'Gmail',
  purpose,
  required: false,
  permission: 'read',
  toolHints: ['search_threads', 'get_thread', 'list_labels'],
});

export const starterSolutions: AgentSolution[] = [
  starter({
    slug: 'executive-daily-brief', name: 'Executive Daily Brief', category: 'Leadership', difficulty: 'intermediate',
    description: 'Turn inbox, workspace context, priorities, and risks into a concise decision-ready daily brief.',
    inputs: [
      { key: 'date', label: 'Brief date', description: 'The date or reporting window.', required: true, example: 'Today' },
      { key: 'priorities', label: 'Current priorities', description: 'The outcomes that matter most right now.', required: true },
    ],
    stages: [
      { name: 'Inbox & Activity Researcher', role: 'Operational signal researcher', goal: 'Collect relevant activity and commitments.', focus: 'Identify messages, deadlines, decisions, and follow-ups relevant to the reporting window.' },
      { name: 'Workspace Context Researcher', role: 'Workspace intelligence analyst', goal: 'Connect activity to project and knowledge context.', focus: 'Find supporting workspace context and note gaps or contradictions.' },
      { name: 'Priority & Risk Analyst', role: 'Executive operations analyst', goal: 'Rank priorities, risks, and required decisions.', focus: 'Assess urgency, impact, dependencies, risks, and decision ownership.' },
      { name: 'Executive Brief Editor', role: 'Executive communications editor', goal: 'Produce a concise daily decision brief.', focus: 'Synthesize the evidence into a scannable executive brief without losing uncertainty.' },
    ],
    output: '# Executive Brief\n## Decisions Required\n## Top Priorities\n## Risks and Blockers\n## Commitments and Deadlines\n## Recommended Next Actions\n## Evidence and Open Questions',
    integrations: [gmailRead('Read relevant email threads and commitments.'), notionRead('Read project and workspace context.')],
  }),
  starter({
    slug: 'client-meeting-preparation', name: 'Client Meeting Preparation', category: 'Client Work', difficulty: 'intermediate',
    description: 'Build a complete client meeting brief from history, opportunities, risks, and unresolved questions.',
    inputs: [
      { key: 'client', label: 'Client or account', description: 'The client being discussed.', required: true },
      { key: 'meeting_objective', label: 'Meeting objective', description: 'What a successful meeting should achieve.', required: true },
    ],
    stages: [
      { name: 'Client History Researcher', role: 'Account history researcher', goal: 'Recover the relevant client relationship history.', focus: 'Summarize prior conversations, decisions, promises, stakeholders, and unresolved items.' },
      { name: 'Account Opportunity Analyst', role: 'Commercial account analyst', goal: 'Identify account needs and realistic opportunities.', focus: 'Map needs, value hypotheses, stakeholder interests, and evidence-supported opportunities.' },
      { name: 'Risk & Question Reviewer', role: 'Client risk reviewer', goal: 'Surface risks and the questions that must be answered.', focus: 'Challenge assumptions, identify relationship and delivery risks, and prioritize open questions.' },
      { name: 'Meeting Brief Writer', role: 'Client meeting strategist', goal: 'Produce a focused meeting plan.', focus: 'Create an actionable agenda, talking points, questions, and desired decisions.' },
    ],
    output: '# Client Meeting Brief\n## Objective\n## Relationship Context\n## Stakeholders\n## Opportunities\n## Risks\n## Agenda\n## Questions to Ask\n## Desired Decisions and Follow-ups',
    integrations: [gmailRead('Read prior client correspondence.'), notionRead('Read account notes and project records.')],
  }),
  starter({
    slug: 'deep-research-report', name: 'Deep Research Report', category: 'Research', difficulty: 'advanced',
    description: 'Plan research, collect evidence, verify claims, and produce a rigorous Markdown report.',
    inputs: [
      { key: 'research_question', label: 'Research question', description: 'The question the report must answer.', required: true },
      { key: 'constraints', label: 'Scope and constraints', description: 'Geography, time range, exclusions, or required sources.', required: false },
    ],
    stages: [
      { name: 'Research Planner', role: 'Senior research planner', goal: 'Turn the question into a testable research plan.', focus: 'Define subquestions, evidence standards, scope, and a research plan.' },
      { name: 'Evidence Collector', role: 'Evidence researcher', goal: 'Collect relevant evidence for each subquestion.', focus: 'Assemble evidence, source details, counter-evidence, and unresolved gaps.' },
      { name: 'Claim Verifier', role: 'Source and claim auditor', goal: 'Evaluate evidence quality and claim support.', focus: 'Check provenance, consistency, uncertainty, and whether conclusions exceed the evidence.' },
      { name: 'Research Report Writer', role: 'Research synthesis lead', goal: 'Write a rigorous decision-useful report.', focus: 'Synthesize verified findings, limitations, and implications into the final report.' },
    ],
    output: '# Research Report\n## Executive Summary\n## Research Question and Method\n## Findings\n## Evidence Table\n## Counter-Evidence\n## Limitations\n## Implications\n## Open Questions',
    integrations: [notionRead('Read workspace research notes and uploaded source context.')],
  }),
  starter({
    slug: 'competitor-intelligence', name: 'Competitor Intelligence', category: 'Strategy', difficulty: 'advanced',
    description: 'Compare competitors, positioning, capabilities, opportunities, and threats using explicit evidence.',
    inputs: [
      { key: 'market', label: 'Market or category', description: 'The competitive market to analyze.', required: true },
      { key: 'competitors', label: 'Competitors', description: 'Known competitors or alternatives.', required: true },
    ],
    stages: [
      { name: 'Competitor Researcher', role: 'Competitive intelligence researcher', goal: 'Build evidence-backed competitor profiles.', focus: 'Collect comparable evidence about competitors, customers, offers, and claims.' },
      { name: 'Positioning Analyst', role: 'Product positioning analyst', goal: 'Compare features, value propositions, and positioning.', focus: 'Normalize comparisons and distinguish stated claims from demonstrated capability.' },
      { name: 'Opportunity & Threat Analyst', role: 'Strategic intelligence analyst', goal: 'Identify defensible opportunities and material threats.', focus: 'Assess gaps, switching drivers, vulnerabilities, and possible strategic responses.' },
      { name: 'Strategy Report Editor', role: 'Competitive strategy editor', goal: 'Deliver a decision-ready intelligence report.', focus: 'Prioritize the most important findings and recommendations with uncertainty clearly labeled.' },
    ],
    output: '# Competitor Intelligence Report\n## Market Context\n## Competitor Profiles\n## Comparison Matrix\n## Positioning Map\n## Opportunities\n## Threats\n## Strategic Recommendations\n## Evidence Gaps',
    integrations: [notionRead('Read existing product, market, and competitor research.')],
  }),
  starter({
    slug: 'proposal-rfp-builder', name: 'Proposal and RFP Builder', category: 'Sales', difficulty: 'advanced',
    description: 'Extract requirements, design a response, challenge delivery risk, and draft a persuasive proposal.',
    inputs: [
      { key: 'requirements', label: 'Requirements or RFP', description: 'Paste or reference the requirements to answer.', required: true },
      { key: 'offer', label: 'Your offer and constraints', description: 'Capabilities, boundaries, pricing assumptions, and differentiators.', required: true },
    ],
    stages: [
      { name: 'Requirement Extractor', role: 'RFP requirements analyst', goal: 'Create a complete requirement and compliance map.', focus: 'Extract explicit and implied requirements, scoring signals, deadlines, and unanswered questions.' },
      { name: 'Solution Architect', role: 'Proposal solution architect', goal: 'Design a feasible response to each requirement.', focus: 'Map capabilities, delivery approach, dependencies, assumptions, and differentiators.' },
      { name: 'Risk & Compliance Reviewer', role: 'Proposal risk reviewer', goal: 'Prevent unsupported commitments and compliance gaps.', focus: 'Challenge feasibility, identify exceptions, and flag claims needing evidence or approval.' },
      { name: 'Proposal Writer', role: 'Commercial proposal writer', goal: 'Produce a clear and persuasive draft proposal.', focus: 'Write the response while preserving caveats, evidence, and unresolved approvals.' },
    ],
    output: '# Proposal Draft\n## Executive Summary\n## Understanding of Requirements\n## Proposed Solution\n## Delivery Plan\n## Requirement Compliance Matrix\n## Assumptions and Dependencies\n## Risks and Exceptions\n## Next Steps',
    integrations: [notionRead('Read approved capability, case-study, and delivery information.')],
    warnings: ['A human must verify pricing, contractual claims, compliance statements, and delivery commitments before submission.'],
  }),
  starter({
    slug: 'content-campaign-studio', name: 'Content Campaign Studio', category: 'Marketing', difficulty: 'intermediate',
    description: 'Research an audience, design a campaign, draft content, and run a fact and brand-quality review.',
    inputs: [
      { key: 'campaign_goal', label: 'Campaign goal', description: 'The business and audience outcome.', required: true },
      { key: 'audience', label: 'Target audience', description: 'Audience, channel, market, and known needs.', required: true },
      { key: 'brand_guidance', label: 'Brand guidance', description: 'Tone, prohibited claims, and required messages.', required: false },
    ],
    stages: [
      { name: 'Audience Researcher', role: 'Audience insight researcher', goal: 'Clarify audience needs and decision context.', focus: 'Identify audience problems, motivations, objections, language, and evidence gaps.' },
      { name: 'Content Strategist', role: 'Campaign content strategist', goal: 'Design a coherent campaign narrative and channel plan.', focus: 'Define messages, content sequence, formats, calls to action, and measurement hypotheses.' },
      { name: 'Content Writer', role: 'Multi-channel content writer', goal: 'Draft campaign content aligned with the strategy.', focus: 'Create the requested content with clear claims, channel fit, and reusable variants.' },
      { name: 'Brand & Fact Reviewer', role: 'Editorial quality reviewer', goal: 'Improve accuracy, consistency, and brand alignment.', focus: 'Check claims, tone, omissions, accessibility, and readiness for human approval.' },
    ],
    output: '# Content Campaign\n## Audience Insight\n## Campaign Strategy\n## Message Architecture\n## Content Calendar\n## Draft Assets\n## Claims Requiring Verification\n## Measurement Plan',
    integrations: [notionRead('Read brand guidance, research, and approved product facts.')],
  }),
  starter({
    slug: 'project-health-recovery', name: 'Project Health and Recovery', category: 'Operations', difficulty: 'advanced',
    description: 'Turn fragmented project information into a health assessment and prioritized recovery plan.',
    inputs: [
      { key: 'project', label: 'Project', description: 'The project, outcome, and current phase.', required: true },
      { key: 'current_status', label: 'Known status', description: 'Available progress, schedule, budget, risks, and blockers.', required: true },
    ],
    stages: [
      { name: 'Project Status Collector', role: 'Project intelligence analyst', goal: 'Build an evidence-based picture of current status.', focus: 'Normalize milestones, decisions, delivery evidence, owners, and gaps.' },
      { name: 'Dependency & Risk Analyst', role: 'Delivery risk analyst', goal: 'Identify the causes and consequences of project risk.', focus: 'Map dependencies, critical paths, blockers, uncertainty, and failure modes.' },
      { name: 'Recovery Planner', role: 'Project recovery strategist', goal: 'Create feasible recovery options and trade-offs.', focus: 'Prioritize corrective actions, owners, sequencing, decision gates, and contingency options.' },
      { name: 'Management Report Writer', role: 'Program communications lead', goal: 'Produce a candid management health report.', focus: 'Summarize health, decisions, recovery plan, accountability, and monitoring indicators.' },
    ],
    output: '# Project Health Report\n## Health Summary\n## Evidence\n## Milestone Status\n## Dependencies and Root Causes\n## Risks\n## Recovery Options\n## Recommended Plan\n## Owners, Dates, and Decision Gates',
    integrations: [notionRead('Read project plans, status notes, decisions, and risk records.'), gmailRead('Read relevant commitments and escalations.')],
  }),
  starter({
    slug: 'customer-feedback-analysis', name: 'Customer Feedback Analysis', category: 'Product', difficulty: 'intermediate',
    description: 'Organize customer feedback into evidence-backed themes, opportunities, and product recommendations.',
    inputs: [
      { key: 'feedback', label: 'Feedback corpus', description: 'Customer comments, interview notes, tickets, or survey responses.', required: true },
      { key: 'product_goal', label: 'Product goal', description: 'The product outcome used to evaluate opportunities.', required: false },
    ],
    stages: [
      { name: 'Feedback Collector', role: 'Voice-of-customer researcher', goal: 'Normalize feedback without erasing customer meaning.', focus: 'Extract feedback units, source context, customer type, and direct evidence.' },
      { name: 'Theme & Sentiment Analyst', role: 'Qualitative research analyst', goal: 'Identify recurring themes and important exceptions.', focus: 'Cluster needs, pain points, sentiment, frequency, severity, and contradictory feedback.' },
      { name: 'Opportunity Prioritizer', role: 'Product opportunity analyst', goal: 'Prioritize opportunities using explicit criteria.', focus: 'Assess customer impact, reach, confidence, strategic fit, dependencies, and risk.' },
      { name: 'Product Insight Writer', role: 'Product research editor', goal: 'Produce an actionable insight report.', focus: 'Connect evidence to opportunities without presenting frequency as certainty.' },
    ],
    output: '# Customer Feedback Analysis\n## Executive Summary\n## Method and Coverage\n## Themes\n## Customer Evidence\n## Exceptions and Contradictions\n## Prioritized Opportunities\n## Recommended Discovery\n## Evidence Gaps',
    integrations: [notionRead('Read customer research, support summaries, and product context.')],
  }),
  starter({
    slug: 'document-due-diligence', name: 'Document Due-Diligence Review', category: 'Risk', difficulty: 'advanced',
    description: 'Extract material claims, identify inconsistencies and risks, and produce a review report for professional follow-up.',
    inputs: [
      { key: 'review_objective', label: 'Review objective', description: 'What decision the review should support.', required: true },
      { key: 'documents', label: 'Documents', description: 'Upload documents to the Knowledge Hub before running.', required: true },
    ],
    stages: [
      { name: 'Document Extractor', role: 'Document evidence analyst', goal: 'Extract material facts, claims, obligations, and dates.', focus: 'Create a traceable inventory of important clauses, claims, figures, entities, and omissions.' },
      { name: 'Inconsistency Analyst', role: 'Cross-document claim analyst', goal: 'Find contradictions, unsupported claims, and missing evidence.', focus: 'Compare documents, dates, numbers, terms, and stated assumptions.' },
      { name: 'Risk Reviewer', role: 'Due-diligence risk analyst', goal: 'Prioritize material risks for professional review.', focus: 'Assess impact, likelihood, ambiguity, evidence strength, and required specialist follow-up.' },
      { name: 'Due-Diligence Report Writer', role: 'Due-diligence report editor', goal: 'Produce a traceable review report.', focus: 'Summarize findings with document references, uncertainty, and explicit professional-review questions.' },
    ],
    output: '# Due-Diligence Review\n## Scope and Disclaimer\n## Document Inventory\n## Material Findings\n## Inconsistencies\n## Risk Register\n## Missing Evidence\n## Questions for Professional Review\n## Recommended Next Steps',
    integrations: [notionRead('Read approved workspace documents and supporting context.')],
    warnings: ['This analysis does not replace legal, financial, regulatory, tax, or other professional advice. A qualified professional must review material decisions.'],
  }),
  starter({
    slug: 'knowledge-base-curator', name: 'Knowledge-Base Curator', category: 'Knowledge', difficulty: 'intermediate',
    description: 'Audit workspace knowledge, detect duplication and contradictions, and propose a maintainable information architecture.',
    inputs: [
      { key: 'scope', label: 'Knowledge scope', description: 'The domain, team, or document collection to curate.', required: true },
      { key: 'audience', label: 'Primary users', description: 'Who needs to find and maintain this knowledge.', required: true },
    ],
    stages: [
      { name: 'Knowledge Inventory Researcher', role: 'Knowledge inventory analyst', goal: 'Map available knowledge and coverage.', focus: 'Inventory topics, document types, owners, freshness, and important gaps.' },
      { name: 'Contradiction Detector', role: 'Knowledge quality analyst', goal: 'Find duplication, conflicts, and stale information.', focus: 'Compare claims, dates, policies, ownership, and versions while preserving source references.' },
      { name: 'Information Architect', role: 'Knowledge systems architect', goal: 'Design a usable organization and governance model.', focus: 'Propose taxonomy, canonical sources, metadata, ownership, review cycles, and migration priorities.' },
      { name: 'Knowledge Summary Writer', role: 'Knowledge operations editor', goal: 'Produce the curation and migration plan.', focus: 'Turn the audit into an actionable structure, backlog, and governance guide.' },
    ],
    output: '# Knowledge Curation Plan\n## Inventory Summary\n## Coverage and Gaps\n## Duplicates and Contradictions\n## Proposed Information Architecture\n## Canonical Sources\n## Migration Backlog\n## Ownership and Review Cadence',
    integrations: [notionRead('Read workspace knowledge pages, databases, and metadata.')],
  }),
];

export function starterSolution(slug: string) {
  return starterSolutions.find((solution) => solution.slug === slug);
}
