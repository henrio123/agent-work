#!/usr/bin/env node
'use strict';

/**
 * gap-scanner.js — Identifies unresolved issues from completed runs.
 *
 * Scans completed runs for a project and detects four gap types:
 *   1. qa_issue_no_followup — high/critical QA issues without follow-up ticket
 *   2. review_changes_unaddressed — changes_requested verdict with no re-run
 *   3. research_open_question — open_questions[] in research findings
 *   4. unresolved_question — open_questions[] in task packs
 *
 * In auto-create mode, calls createTicketAndBacklog() per gap.
 * Without auto-create, no files are written (read-only).
 *
 * CLI:
 *   node gap-scanner.js --project <project_id> [--auto_create]
 *
 * Exports:
 *   scanGaps({ workspaceRoot, projectId, autoCreate }) → result
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');

let _ticketModule = null;

function getTicketModule() {
  if (!_ticketModule) {
    _ticketModule = require(path.resolve(__dirname, 'create-ticket-and-backlog.js'));
  }
  return _ticketModule;
}

// ---------------------------------------------------------------------------
// Gap detection helpers
// ---------------------------------------------------------------------------

function findQaGaps(runDir, runFolderRel, ticketId, backlogItems) {
  const gaps = [];
  const qaPath = path.join(runDir, '50-qa-report.json');
  if (!fs.existsSync(qaPath)) return gaps;

  let qa;
  try {
    qa = JSON.parse(fs.readFileSync(qaPath, 'utf8'));
  } catch { return gaps; }

  if (!Array.isArray(qa.issues)) return gaps;

  // Only flag high/critical issues
  const severeIssues = qa.issues.filter(i => i.severity === 'high' || i.severity === 'critical');

  for (let idx = 0; idx < severeIssues.length; idx++) {
    const issue = severeIssues[idx];
    const gapTitle = `QA issue: ${issue.description}`.slice(0, 120);

    // Check if a backlog item already exists with this title
    const alreadyExists = backlogItems.some(b => b.title === gapTitle);
    if (alreadyExists) continue;

    gaps.push({
      type: 'qa_issue_no_followup',
      severity: issue.severity,
      source_run: runFolderRel,
      title: gapTitle,
      description: `Unresolved ${issue.severity} QA issue from ${ticketId}: ${issue.description}`,
      _ticket_id_base: ticketId,
    });
  }

  return gaps;
}

function findReviewGaps(runDir, runFolderRel, ticketId, allRuns, backlogItems) {
  const gaps = [];
  const reviewPath = path.join(runDir, '60-review-report.json');
  if (!fs.existsSync(reviewPath)) return gaps;

  let review;
  try {
    review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
  } catch { return gaps; }

  if (review.verdict !== 'changes_requested') return gaps;

  // Check if there's a later run for the same ticket (re-run)
  const hasReRun = allRuns.some(r => r !== runFolderRel && r > runFolderRel);
  if (hasReRun) return gaps;

  const gapTitle = `Review changes unaddressed: ${ticketId}`;
  const alreadyExists = backlogItems.some(b => b.title === gapTitle);
  if (alreadyExists) return gaps;

  gaps.push({
    type: 'review_changes_unaddressed',
    severity: 'high',
    source_run: runFolderRel,
    title: gapTitle,
    description: `Review requested changes for ${ticketId} but no follow-up run exists.`,
    _ticket_id_base: ticketId,
  });

  return gaps;
}

function findResearchGaps(runDir, runFolderRel, ticketId, backlogItems) {
  const gaps = [];
  const researchPath = path.join(runDir, '18-research-findings.json');
  if (!fs.existsSync(researchPath)) return gaps;

  let research;
  try {
    research = JSON.parse(fs.readFileSync(researchPath, 'utf8'));
  } catch { return gaps; }

  if (!Array.isArray(research.open_questions)) return gaps;

  for (const question of research.open_questions) {
    const q = typeof question === 'string' ? question : (question.question || JSON.stringify(question));
    const gapTitle = `Research question: ${q}`.slice(0, 120);

    const alreadyExists = backlogItems.some(b => b.title === gapTitle);
    if (alreadyExists) continue;

    gaps.push({
      type: 'research_open_question',
      severity: 'medium',
      source_run: runFolderRel,
      title: gapTitle,
      description: `Open research question from ${ticketId}: ${q}`,
      _ticket_id_base: ticketId,
    });
  }

  return gaps;
}

function findTaskPackGaps(workspaceRoot, projectId, backlogItems) {
  const gaps = [];
  const taskPacksDir = path.join(workspaceRoot, '.claw', 'task-packs');
  if (!fs.existsSync(taskPacksDir)) return gaps;

  let files;
  try {
    files = fs.readdirSync(taskPacksDir).filter(f => f.endsWith('.json')).sort();
  } catch { return gaps; }

  for (const file of files) {
    let pack;
    try {
      pack = JSON.parse(fs.readFileSync(path.join(taskPacksDir, file), 'utf8'));
    } catch { continue; }

    if (!Array.isArray(pack.open_questions)) continue;
    const ticketId = pack.ticket_id || file.replace('.json', '');

    for (const question of pack.open_questions) {
      const q = typeof question === 'string' ? question : (question.question || JSON.stringify(question));
      const gapTitle = `Unresolved question: ${q}`.slice(0, 120);

      const alreadyExists = backlogItems.some(b => b.title === gapTitle);
      if (alreadyExists) continue;

      gaps.push({
        type: 'unresolved_question',
        severity: 'low',
        source_run: `task-pack/${ticketId}`,
        title: gapTitle,
        description: `Unresolved question from task pack ${ticketId}: ${q}`,
        _ticket_id_base: ticketId,
      });
    }
  }

  return gaps;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------
function scanGaps(options = {}) {
  const workspaceRoot = options.workspaceRoot || WORKSPACE_ROOT;
  const projectId = options.projectId;
  const autoCreate = options.autoCreate || false;

  if (!projectId) return { ok: false, error: 'projectId is required' };

  const runsDir = path.join(workspaceRoot, '.claw', 'runs');
  const backlogDir = path.join(workspaceRoot, '.claw', 'backlog');

  // Load existing backlog items for idempotency checks
  const backlogItems = [];
  if (fs.existsSync(backlogDir)) {
    try {
      const files = fs.readdirSync(backlogDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const item = JSON.parse(fs.readFileSync(path.join(backlogDir, file), 'utf8'));
          backlogItems.push(item);
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  const allGaps = [];
  let gapSeq = 0;

  // Scan runs
  if (fs.existsSync(runsDir)) {
    let runNames;
    try {
      runNames = fs.readdirSync(runsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort();
    } catch { runNames = []; }

    const projectRunNames = [];
    const runMeta = new Map();

    for (const runName of runNames) {
      const runDir = path.join(runsDir, runName);
      const statusPath = path.join(runDir, 'status.json');
      if (!fs.existsSync(statusPath)) continue;

      let status;
      try {
        status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      } catch { continue; }

      if (status.project !== projectId) continue;

      const relPath = `.claw/runs/${runName}`;
      projectRunNames.push(relPath);
      runMeta.set(relPath, { dir: runDir, ticketId: status.ticket_id || runName });
    }

    for (const relPath of projectRunNames) {
      const meta = runMeta.get(relPath);
      const qaGaps = findQaGaps(meta.dir, relPath, meta.ticketId, backlogItems);
      const reviewGaps = findReviewGaps(meta.dir, relPath, meta.ticketId, projectRunNames, backlogItems);
      const researchGaps = findResearchGaps(meta.dir, relPath, meta.ticketId, backlogItems);

      for (const gap of [...qaGaps, ...reviewGaps, ...researchGaps]) {
        gapSeq++;
        gap.id = `GAP-${gap._ticket_id_base}-${gapSeq}`;
        delete gap._ticket_id_base;
        gap.auto_created_ticket = null;
        allGaps.push(gap);
      }
    }
  }

  // Task pack gaps
  const tpGaps = findTaskPackGaps(workspaceRoot, projectId, backlogItems);
  for (const gap of tpGaps) {
    gapSeq++;
    gap.id = `GAP-${gap._ticket_id_base}-${gapSeq}`;
    delete gap._ticket_id_base;
    gap.auto_created_ticket = null;
    allGaps.push(gap);
  }

  // Auto-create mode
  let autoCreatedCount = 0;
  if (autoCreate) {
    const { createTicketAndBacklog } = getTicketModule();

    for (const gap of allGaps) {
      const ticketId = gap.id;

      // Idempotency: check if backlog item with same title already exists
      const exists = backlogItems.some(b => b.title === gap.title);
      if (exists) continue;

      try {
        const result = createTicketAndBacklog({
          ticket_id: ticketId,
          title: gap.title,
          project_id: projectId,
          description: gap.description,
          type: 'task',
          priority: gap.severity === 'critical' ? 'P0' : gap.severity === 'high' ? 'P1' : 'P2',
          owner_role: 'DEV',
          goal: `Resolve: ${gap.title}`,
          steps: ['Investigate the gap', 'Implement fix', 'Verify resolution'],
        }, { workspaceRoot });

        if (result.ok) {
          gap.auto_created_ticket = ticketId;
          autoCreatedCount++;
          // Add to backlogItems for subsequent idempotency checks
          backlogItems.push({ id: ticketId, title: gap.title });
        }
      } catch {
        // Failed to create — leave auto_created_ticket as null
      }
    }
  }

  // Summary
  const byType = {};
  const bySeverity = {};
  for (const gap of allGaps) {
    byType[gap.type] = (byType[gap.type] || 0) + 1;
    bySeverity[gap.severity] = (bySeverity[gap.severity] || 0) + 1;
  }

  return {
    ok: true,
    action: 'gaps_scanned',
    project_id: projectId,
    gaps: allGaps,
    summary: {
      total_gaps: allGaps.length,
      by_type: byType,
      by_severity: bySeverity,
      auto_created_count: autoCreatedCount,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  function getArg(name) {
    const idx = args.indexOf(`--${name}`);
    if (idx === -1 || idx + 1 >= args.length) return undefined;
    return args[idx + 1];
  }

  const projectId = getArg('project');
  const autoCreate = args.includes('--auto_create');

  if (!projectId) {
    process.stderr.write(JSON.stringify({ ok: false, error: '--project is required' }) + '\n');
    process.exit(1);
  }

  const result = scanGaps({ projectId, autoCreate });
  if (!result.ok) {
    process.stderr.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { scanGaps };
