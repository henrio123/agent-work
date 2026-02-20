#!/usr/bin/env node
'use strict';

/**
 * generate-context-pack.js — Deterministic repo scanner that produces a
 * "context pack" for a specific focus area (e.g. booking-flow).
 *
 * Output files (written to WORKSPACE_ROOT/.claw/context/):
 *   - <focus>.context.json   (machine-readable)
 *   - <focus>.summary.md     (human-readable)
 *   - <focus>.files.txt      (newline-separated file list)
 *
 * Usage:
 *   node generate-context-pack.js --focus booking-flow [--workspace /path]
 *
 * Determinism guarantees:
 *   - All lists sorted alphabetically
 *   - Commit hash included in metadata
 *   - No timestamps (reproducible from same repo state)
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const os = require('node:os');

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'dev', 'agent-work');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(msg) {
  process.stderr.write(JSON.stringify({ ok: false, error: msg }) + '\n');
  process.exit(1);
}

function ok(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

function getGitCommitHash(dir) {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: dir, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function readFileIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Recursively find files matching a test function.
 * Returns sorted array of relative paths (from baseDir).
 */
function findFiles(baseDir, testFn, _rel) {
  _rel = _rel || '';
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(path.join(baseDir, _rel), { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const rel = path.join(_rel, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.next' || entry.name === '.claw') continue;
      results.push(...findFiles(baseDir, testFn, rel));
    } else if (testFn(rel, entry.name)) {
      results.push(rel);
    }
  }
  return results.sort();
}

/**
 * Extract ES import/require paths from a source file.
 * Returns sorted unique list of import specifiers.
 */
function extractImports(source) {
  const imports = new Set();
  // ES import: import X from 'Y' or import { X } from 'Y'
  const esRe = /import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  // Dynamic import: import('Y')
  const dynRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  // require('Y')
  const reqRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;

  let m;
  while ((m = esRe.exec(source)) !== null) imports.add(m[1]);
  while ((m = dynRe.exec(source)) !== null) imports.add(m[1]);
  while ((m = reqRe.exec(source)) !== null) imports.add(m[1]);
  return [...imports].sort();
}

/**
 * Detect React hooks, state management patterns, and data fetching in source.
 */
function detectStatePatterns(source) {
  const patterns = [];
  if (/\buseState\b/.test(source)) patterns.push('useState');
  if (/\buseReducer\b/.test(source)) patterns.push('useReducer');
  if (/\buseContext\b/.test(source)) patterns.push('useContext');
  if (/\buseEffect\b/.test(source)) patterns.push('useEffect');
  if (/\buseMemo\b/.test(source)) patterns.push('useMemo');
  if (/\buseCallback\b/.test(source)) patterns.push('useCallback');
  if (/\buseRef\b/.test(source)) patterns.push('useRef');
  // State libraries
  if (/\buseStore\b|\bcreate\b.*zustand/i.test(source)) patterns.push('zustand');
  if (/\buseSelector\b|\buseDispatch\b/.test(source)) patterns.push('redux');
  // Server actions / data fetching
  if (/['"]use server['"]/.test(source)) patterns.push('server-action');
  if (/\bfetch\s*\(/.test(source)) patterns.push('fetch');
  if (/\baxios\b/.test(source)) patterns.push('axios');
  if (/\buseSWR\b/.test(source)) patterns.push('swr');
  if (/\buseQuery\b/.test(source)) patterns.push('react-query');
  return patterns.sort();
}

/**
 * Extract API endpoints from fetch calls in source.
 */
function extractApiCalls(source) {
  const endpoints = new Set();
  // fetch('/api/...') or fetch(`/api/...`)
  const fetchRe = /fetch\s*\(\s*[`'"](\/api\/[^`'"]*)[`'"]/g;
  let m;
  while ((m = fetchRe.exec(source)) !== null) {
    // Normalize template literals: replace ${...} with :param
    endpoints.add(m[1].replace(/\$\{[^}]+\}/g, ':param'));
  }
  // Also match string concatenation patterns like '/api/appointments/' + id
  const concatRe = /fetch\s*\(\s*['"]?(\/api\/[^'"+ ]*)/g;
  while ((m = concatRe.exec(source)) !== null) {
    endpoints.add(m[1]);
  }
  return [...endpoints].sort();
}

/**
 * Extract i18n translation key usage from source.
 * Looks for t('key'), t.key, translations.key patterns.
 */
function extractI18nKeys(source) {
  const keys = new Set();
  // t('key') or t("key") or t(`key`)
  const tCallRe = /\bt\s*\(\s*['"`]([a-zA-Z_][a-zA-Z0-9_.]*?)['"`]\s*\)/g;
  // t.key (direct property access on translation object)
  const tDotRe = /\bt\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let m;
  while ((m = tCallRe.exec(source)) !== null) keys.add(m[1]);
  while ((m = tDotRe.exec(source)) !== null) keys.add(m[1]);
  return [...keys].sort();
}

/**
 * Extract analytics event names from source.
 */
function extractAnalyticsEvents(source) {
  const events = new Set();
  // trackBookingEvent('event_name', ...) or trackEvent('event_name', ...)
  const trackRe = /track(?:Booking)?Event\s*\(\s*['"`]([a-zA-Z_]+)['"`]/g;
  let m;
  while ((m = trackRe.exec(source)) !== null) events.add(m[1]);
  return [...events].sort();
}

/**
 * Detect UX-relevant patterns: forms, validation, loading, error, disabled states.
 */
function detectUxPatterns(source) {
  const patterns = [];
  if (/<form\b/i.test(source) || /onSubmit/i.test(source)) patterns.push('form');
  if (/\bvalidat/i.test(source) || /\brequired\b/.test(source) || /\.test\s*\(/.test(source)) patterns.push('validation');
  if (/\berror\b/i.test(source) && (/setError|isError|error\s*[=!]|\.error\b/.test(source))) patterns.push('error-state');
  if (/\bloading\b/i.test(source) || /isLoading|setLoading/.test(source) || /\bSkeleton\b/.test(source)) patterns.push('loading-state');
  if (/\bdisabled\b/i.test(source)) patterns.push('disabled-state');
  if (/\bmodal\b/i.test(source) || /\bDialog\b/.test(source)) patterns.push('modal');
  if (/\btoast\b/i.test(source) || /\bnotif/i.test(source)) patterns.push('notification');
  return patterns.sort();
}

// ---------------------------------------------------------------------------
// Focus: booking-flow
// ---------------------------------------------------------------------------

function scanBookingFlow(wsRoot) {
  const srcDir = path.join(wsRoot, 'src');
  const bookDir = path.join(srcDir, 'app', 'book');

  if (!fs.existsSync(bookDir)) {
    fail(`Booking flow directory not found: ${path.relative(wsRoot, bookDir)}`);
  }

  // 1. Route detection — find all page.tsx under /book
  const bookingFiles = findFiles(bookDir, (rel, name) =>
    /\.(tsx?|jsx?)$/.test(name)
  );

  // Map routes
  const routes = [];
  const routePageMap = {};
  for (const relFile of bookingFiles) {
    if (path.basename(relFile) === 'page.tsx' || path.basename(relFile) === 'page.ts') {
      const routeDir = path.dirname(relFile);
      const route = '/book' + (routeDir === '.' ? '' : '/' + routeDir.replace(/\\/g, '/'));
      const fullPath = 'src/app/book/' + relFile;
      routes.push({ route, page: fullPath });
      routePageMap[route] = fullPath;
    }
  }
  routes.sort((a, b) => a.route.localeCompare(b.route));

  // 2. Component graph — for each booking file, extract imports
  const allBookingFilePaths = bookingFiles.map(f => 'src/app/book/' + f);

  // Also find shared booking components
  const bookComponentDir = path.join(bookDir, 'components');
  const bookComponents = findFiles(bookComponentDir, (rel, name) =>
    /\.(tsx?|jsx?)$/.test(name)
  ).map(f => 'src/app/book/components/' + f);

  const allFiles = [...new Set([...allBookingFilePaths, ...bookComponents])].sort();

  // Analyze each file
  const fileAnalysis = {};
  const allApiEndpoints = new Set();
  const allI18nKeys = new Set();
  const allAnalyticsEvents = new Set();
  const allStatePatterns = new Set();
  const allUxPatterns = {};

  for (const relFile of allFiles) {
    const absPath = path.join(wsRoot, relFile);
    const source = readFileIfExists(absPath);
    if (!source) continue;

    const imports = extractImports(source);
    const statePatterns = detectStatePatterns(source);
    const apiCalls = extractApiCalls(source);
    const i18nKeys = extractI18nKeys(source);
    const analyticsEvents = extractAnalyticsEvents(source);
    const uxPatterns = detectUxPatterns(source);

    // Identify component imports (relative or from components/)
    const componentImports = imports.filter(i =>
      i.startsWith('./') || i.startsWith('../') || i.startsWith('@/components') || i.startsWith('@/app/book/components')
    ).sort();

    fileAnalysis[relFile] = {
      imports: componentImports,
      state_patterns: statePatterns,
      api_calls: apiCalls,
      i18n_keys: i18nKeys,
      analytics_events: analyticsEvents,
      ux_patterns: uxPatterns,
    };

    apiCalls.forEach(e => allApiEndpoints.add(e));
    i18nKeys.forEach(k => allI18nKeys.add(k));
    analyticsEvents.forEach(e => allAnalyticsEvents.add(e));
    statePatterns.forEach(p => allStatePatterns.add(p));
    uxPatterns.forEach(p => {
      allUxPatterns[p] = (allUxPatterns[p] || 0) + 1;
    });
  }

  // 3. Also scan API routes relevant to booking
  const apiDir = path.join(srcDir, 'app', 'api');
  const bookingApiFiles = [];
  const apiPatterns = ['appointments', 'customers', 'services', 'barbers', 'slots', 'shops'];
  for (const pattern of apiPatterns) {
    const apiSubDir = path.join(apiDir, pattern);
    if (fs.existsSync(apiSubDir)) {
      const files = findFiles(apiSubDir, (rel, name) => /\.(tsx?|jsx?)$/.test(name));
      for (const f of files) {
        bookingApiFiles.push('src/app/api/' + pattern + '/' + f);
      }
    }
  }
  bookingApiFiles.sort();

  // 4. Scan Prisma schema for booking-related models
  const prismaModels = [];
  const prismaSchemaPath = path.join(wsRoot, 'prisma', 'schema.prisma');
  const prismaSource = readFileIfExists(prismaSchemaPath);
  if (prismaSource) {
    const modelRe = /^model\s+(\w+)\s*\{/gm;
    let m;
    while ((m = modelRe.exec(prismaSource)) !== null) {
      prismaModels.push(m[1]);
    }
    prismaModels.sort();
  }

  // 5. Scan analytics definition file
  const analyticsFile = path.join(srcDir, 'lib', 'analytics', 'booking.ts');
  const analyticsSource = readFileIfExists(analyticsFile);
  const definedEvents = [];
  if (analyticsSource) {
    // Extract from type literal union
    const eventRe = /'\s*([a-zA-Z_]+)\s*'/g;
    const typeSection = analyticsSource.match(/BookingEventName\s*=[\s\S]*?;/);
    if (typeSection) {
      let m;
      while ((m = eventRe.exec(typeSection[0])) !== null) {
        definedEvents.push(m[1]);
      }
    }
    definedEvents.sort();
  }

  // 6. i18n — scan translation file for all available keys
  const translationsFile = path.join(srcDir, 'lib', 'i18n', 'translations.ts');
  const translationsSource = readFileIfExists(translationsFile);
  const allTranslationKeys = [];
  if (translationsSource) {
    // Extract interface keys
    const keyRe = /^\s+(\w+)\s*:/gm;
    let m;
    while ((m = keyRe.exec(translationsSource)) !== null) {
      allTranslationKeys.push(m[1]);
    }
    allTranslationKeys.sort();
  }

  // Booking-used i18n keys vs all available
  const usedKeys = [...allI18nKeys].sort();
  const bookingRelatedTranslationKeys = allTranslationKeys.filter(k =>
    usedKeys.includes(k) ||
    /book|service|barber|time|slot|confirm|appointment|cancel|reschedule|upsell/i.test(k)
  ).sort();

  // Build context pack
  const commitHash = getGitCommitHash(wsRoot);

  const context = {
    metadata: {
      focus: 'booking-flow',
      workspace: wsRoot,
      commit: commitHash,
      files_scanned: allFiles.length + bookingApiFiles.length,
    },
    routes: routes,
    files: {
      booking_pages: allBookingFilePaths.sort(),
      booking_components: bookComponents.sort(),
      booking_api: bookingApiFiles,
      analytics: analyticsSource ? ['src/lib/analytics/booking.ts'] : [],
      i18n: translationsSource ? ['src/lib/i18n/translations.ts'] : [],
      prisma_schema: prismaSource ? ['prisma/schema.prisma'] : [],
    },
    component_graph: Object.fromEntries(
      Object.entries(fileAnalysis)
        .filter(([, v]) => v.imports.length > 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, v.imports])
    ),
    state_management: {
      patterns_used: [...allStatePatterns].sort(),
      by_file: Object.fromEntries(
        Object.entries(fileAnalysis)
          .filter(([, v]) => v.state_patterns.length > 0)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, v.state_patterns])
      ),
    },
    api_endpoints: {
      called_from_booking: [...allApiEndpoints].sort(),
      api_route_files: bookingApiFiles,
    },
    i18n: {
      locales: ['en', 'et', 'ru'],
      keys_used_in_booking: usedKeys,
      booking_related_keys: bookingRelatedTranslationKeys,
      total_translation_keys: allTranslationKeys.length,
    },
    analytics: {
      defined_events: definedEvents,
      events_used_in_booking: [...allAnalyticsEvents].sort(),
      backend: 'console.debug only (no production backend)',
      analytics_file: analyticsSource ? 'src/lib/analytics/booking.ts' : null,
    },
    ux_signals: {
      patterns_detected: Object.fromEntries(
        Object.entries(allUxPatterns).sort(([a], [b]) => a.localeCompare(b))
      ),
      by_file: Object.fromEntries(
        Object.entries(fileAnalysis)
          .filter(([, v]) => v.ux_patterns.length > 0)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, v.ux_patterns])
      ),
    },
    prisma_models: prismaModels,
  };

  return context;
}

// ---------------------------------------------------------------------------
// Output generators
// ---------------------------------------------------------------------------

function generateSummaryMarkdown(ctx) {
  const lines = [];
  lines.push(`# Context Pack: ${ctx.metadata.focus}`);
  lines.push(`Commit: ${ctx.metadata.commit} | Files scanned: ${ctx.metadata.files_scanned}`);
  lines.push('');

  lines.push('## Routes');
  lines.push('| Step | Route | Page |');
  lines.push('|------|-------|------|');
  ctx.routes.forEach((r, i) => {
    lines.push(`| ${i + 1} | ${r.route} | ${r.page} |`);
  });
  lines.push('');

  lines.push('## File Inventory');
  lines.push(`- Booking pages: ${ctx.files.booking_pages.length}`);
  lines.push(`- Booking components: ${ctx.files.booking_components.length}`);
  lines.push(`- API route files: ${ctx.files.booking_api.length}`);
  lines.push('');

  lines.push('## Component Imports');
  for (const [file, imports] of Object.entries(ctx.component_graph)) {
    lines.push(`- **${file}**: ${imports.join(', ')}`);
  }
  lines.push('');

  lines.push('## State Management');
  lines.push(`Patterns: ${ctx.state_management.patterns_used.join(', ') || 'none detected'}`);
  for (const [file, patterns] of Object.entries(ctx.state_management.by_file)) {
    lines.push(`- ${file}: ${patterns.join(', ')}`);
  }
  lines.push('');

  lines.push('## API Endpoints Called');
  ctx.api_endpoints.called_from_booking.forEach(e => lines.push(`- ${e}`));
  lines.push('');

  lines.push('## i18n');
  lines.push(`Locales: ${ctx.i18n.locales.join(', ')}`);
  lines.push(`Keys used in booking flow: ${ctx.i18n.keys_used_in_booking.length} / ${ctx.i18n.total_translation_keys} total`);
  if (ctx.i18n.keys_used_in_booking.length > 0) {
    lines.push('');
    ctx.i18n.keys_used_in_booking.forEach(k => lines.push(`- ${k}`));
  }
  lines.push('');

  lines.push('## Analytics Events');
  lines.push(`Defined: ${ctx.analytics.defined_events.length} | Used in booking: ${ctx.analytics.events_used_in_booking.length}`);
  lines.push(`Backend: ${ctx.analytics.backend}`);
  ctx.analytics.events_used_in_booking.forEach(e => lines.push(`- ${e}`));
  lines.push('');

  lines.push('## UX Signals');
  for (const [pattern, count] of Object.entries(ctx.ux_signals.patterns_detected)) {
    lines.push(`- ${pattern}: ${count} file(s)`);
  }
  lines.push('');

  lines.push('## Prisma Models');
  ctx.prisma_models.forEach(m => lines.push(`- ${m}`));
  lines.push('');

  return lines.join('\n');
}

function generateFileList(ctx) {
  const allFiles = new Set();
  for (const group of Object.values(ctx.files)) {
    group.forEach(f => allFiles.add(f));
  }
  return [...allFiles].sort().join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function run(wsRoot, focus) {
  if (!focus) fail('Missing --focus argument. Supported: booking-flow');

  const clawDir = path.join(wsRoot, '.claw');
  if (!fs.existsSync(clawDir)) fail('.claw/ directory not found in workspace');

  let context;
  switch (focus) {
    case 'booking-flow':
      context = scanBookingFlow(wsRoot);
      break;
    default:
      fail(`Unknown focus: ${focus}. Supported: booking-flow`);
  }

  // Write outputs
  const outDir = path.join(clawDir, 'context');
  fs.mkdirSync(outDir, { recursive: true });

  const jsonPath = path.join(outDir, `${focus}.context.json`);
  const mdPath = path.join(outDir, `${focus}.summary.md`);
  const filesPath = path.join(outDir, `${focus}.files.txt`);

  fs.writeFileSync(jsonPath, JSON.stringify(context, null, 2) + '\n', 'utf8');
  fs.writeFileSync(mdPath, generateSummaryMarkdown(context), 'utf8');
  fs.writeFileSync(filesPath, generateFileList(context), 'utf8');

  ok({
    ok: true,
    focus,
    commit: context.metadata.commit,
    files_scanned: context.metadata.files_scanned,
    routes: context.routes.length,
    api_endpoints: context.api_endpoints.called_from_booking.length,
    i18n_keys: context.i18n.keys_used_in_booking.length,
    analytics_events: context.analytics.events_used_in_booking.length,
    ux_patterns: Object.keys(context.ux_signals.patterns_detected).length,
    outputs: {
      json: path.relative(wsRoot, jsonPath),
      summary: path.relative(wsRoot, mdPath),
      files: path.relative(wsRoot, filesPath),
    },
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  let focus = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--focus' && i + 1 < args.length) {
      focus = args[i + 1];
      i++;
    }
  }

  if (!focus) {
    fail('Usage: generate-context-pack.js --focus booking-flow');
  }

  run(WORKSPACE_ROOT, focus);
}

module.exports = { run, scanBookingFlow };
