#!/usr/bin/env node
'use strict';

/**
 * Tests for generate-context-pack.js
 *
 * Creates a minimal mock Next.js project structure in a tmpdir,
 * runs the scanner, and validates the output.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'generate-context-pack.js');

let tmpDir;
let passed = 0;
let failed = 0;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-ctx-pack-'));
  // Initialize git repo for commit hash
  execSync('git init && git config user.email "test@test.com" && git config user.name "Test" && git commit --allow-empty -m "init"', { cwd: tmpDir, stdio: 'pipe' });
  // Create .claw/
  fs.mkdirSync(path.join(tmpDir, '.claw'), { recursive: true });
  // Create minimal Next.js booking-flow structure
  const bookDir = path.join(tmpDir, 'src', 'app', 'book');
  fs.mkdirSync(bookDir, { recursive: true });
  fs.mkdirSync(path.join(bookDir, 'barber'), { recursive: true });
  fs.mkdirSync(path.join(bookDir, 'confirm'), { recursive: true });
  fs.mkdirSync(path.join(bookDir, 'time'), { recursive: true });
  fs.mkdirSync(path.join(bookDir, 'success'), { recursive: true });
  fs.mkdirSync(path.join(bookDir, 'components'), { recursive: true });

  // Page files with realistic content
  fs.writeFileSync(path.join(bookDir, 'page.tsx'), `
import { useState, useEffect } from 'react';
import { StickyFooter } from './components/StickyFooter';
import styles from './book.module.css';

export default function ServicePage() {
  const [services, setServices] = useState([]);
  const { t } = useLanguage();

  useEffect(() => {
    fetch('/api/services?shopId=\${shopId}').then(r => r.json()).then(setServices);
  }, []);

  trackBookingEvent('booking_step_view', { stepId: 'service' });

  return <form onSubmit={handleSubmit}><div>{t.selectService}</div><div>{t.allServices}</div></form>;
}
`);

  fs.writeFileSync(path.join(bookDir, 'barber', 'page.tsx'), `
import { useState, useEffect } from 'react';
import { ProgressBar } from '../components/ProgressBar';
export default function BarberPage() {
  const [barbers, setBarbers] = useState([]);
  useEffect(() => { fetch('/api/barbers?shopId=\${id}'); }, []);
  trackBookingEvent('booking_step_view', { stepId: 'barber' });
  return <div>{t.selectBarber}</div>;
}
`);

  fs.writeFileSync(path.join(bookDir, 'time', 'page.tsx'), `
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ProgressBar } from '../components/ProgressBar';
export default function TimePage() {
  const [slots, setSlots] = useState([]);
  const isLoading = true;
  useEffect(() => { fetch('/api/slots/recommend?date=\${d}'); }, []);
  trackBookingEvent('slot_clicked', { stepId: 'time' });
  return <div>{t.selectTime}</div>;
}
`);

  fs.writeFileSync(path.join(bookDir, 'confirm', 'page.tsx'), `
import { useState, useEffect, useRef } from 'react';
import { StickyFooter } from '../components/StickyFooter';
export default function ConfirmPage() {
  const [error, setError] = useState(null);
  const isLoading = false;
  const disabled = !valid;
  useEffect(() => { fetch('/api/customers'); fetch('/api/appointments'); }, []);
  const emailValid = /^[^@]+@[^@]+/.test(email);
  trackBookingEvent('booking_completed', { stepId: 'confirm' });
  return <form>{t.confirmBooking} {t.email} {t.emailRequired} {t.firstName}</form>;
}
`);

  fs.writeFileSync(path.join(bookDir, 'success', 'page.tsx'), `
import { useEffect, useState, useCallback } from 'react';
export default function SuccessPage() {
  const [booking, setBooking] = useState(null);
  useEffect(() => { fetch('/api/appointments/\${id}'); }, []);
  return <div>{t.bookingConfirmed}</div>;
}
`);

  fs.writeFileSync(path.join(bookDir, 'layout.tsx'), `
export default function BookLayout({ children }) { return <div>{children}</div>; }
`);

  fs.writeFileSync(path.join(bookDir, 'components', 'ProgressBar.tsx'), `
export function ProgressBar({ step }) { return <div>Step {step}</div>; }
`);

  fs.writeFileSync(path.join(bookDir, 'components', 'StickyFooter.tsx'), `
export function StickyFooter({ children }) { return <footer>{children}</footer>; }
`);

  // API routes
  const apiDir = path.join(tmpDir, 'src', 'app', 'api');
  fs.mkdirSync(path.join(apiDir, 'appointments'), { recursive: true });
  fs.mkdirSync(path.join(apiDir, 'services'), { recursive: true });
  fs.mkdirSync(path.join(apiDir, 'slots'), { recursive: true });
  fs.writeFileSync(path.join(apiDir, 'appointments', 'route.ts'), 'export async function GET() {}');
  fs.writeFileSync(path.join(apiDir, 'services', 'route.ts'), 'export async function GET() {}');
  fs.writeFileSync(path.join(apiDir, 'slots', 'route.ts'), 'export async function GET() {}');

  // Analytics
  fs.mkdirSync(path.join(tmpDir, 'src', 'lib', 'analytics'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'src', 'lib', 'analytics', 'booking.ts'), `
export type BookingEventName = 'booking_step_view' | 'booking_completed' | 'slot_clicked';
export function trackBookingEvent(name: BookingEventName, payload: any) {}
`);

  // i18n
  fs.mkdirSync(path.join(tmpDir, 'src', 'lib', 'i18n'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'src', 'lib', 'i18n', 'translations.ts'), `
export interface Translations {
  selectService: string;
  allServices: string;
  selectBarber: string;
  selectTime: string;
  confirmBooking: string;
  email: string;
  emailRequired: string;
  firstName: string;
  bookingConfirmed: string;
  loading: string;
  goBack: string;
}
`);

  // Prisma
  fs.mkdirSync(path.join(tmpDir, 'prisma'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'prisma', 'schema.prisma'), `
model Appointment {
  id String @id
}
model Customer {
  id String @id
}
model Service {
  id String @id
}
`);
}

function cleanup() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

function test(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${label}`);
    console.log(`        ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function runCli(extraArgs) {
  const cmd = `node "${SCRIPT}" --focus booking-flow ${extraArgs || ''}`;
  const env = { ...process.env, WORKSPACE_ROOT: tmpDir };
  return execSync(cmd, { encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'] });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('\n=== generate-context-pack ===\n');
console.log('--- setup ---');
setup();

console.log('--- CLI ---');

test('exits non-zero without --focus', () => {
  try {
    execSync(`node "${SCRIPT}"`, { encoding: 'utf8', env: { ...process.env, WORKSPACE_ROOT: tmpDir }, stdio: 'pipe' });
    assert(false, 'should have thrown');
  } catch (e) {
    assert(e.status !== 0);
  }
});

test('exits non-zero for unknown focus', () => {
  try {
    execSync(`node "${SCRIPT}" --focus unknown-thing`, { encoding: 'utf8', env: { ...process.env, WORKSPACE_ROOT: tmpDir }, stdio: 'pipe' });
    assert(false, 'should have thrown');
  } catch (e) {
    assert(e.status !== 0);
  }
});

test('succeeds for booking-flow focus', () => {
  const out = runCli();
  const result = JSON.parse(out);
  assert(result.ok === true, 'ok should be true');
  assert(result.focus === 'booking-flow');
});

console.log('--- output files ---');

test('creates booking-flow.context.json', () => {
  assert(fs.existsSync(path.join(tmpDir, '.claw', 'context', 'booking-flow.context.json')));
});

test('creates booking-flow.summary.md', () => {
  assert(fs.existsSync(path.join(tmpDir, '.claw', 'context', 'booking-flow.summary.md')));
});

test('creates booking-flow.files.txt', () => {
  assert(fs.existsSync(path.join(tmpDir, '.claw', 'context', 'booking-flow.files.txt')));
});

console.log('--- context JSON structure ---');

const ctx = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claw', 'context', 'booking-flow.context.json'), 'utf8'));

test('metadata has focus and commit', () => {
  assert(ctx.metadata.focus === 'booking-flow');
  assert(typeof ctx.metadata.commit === 'string' && ctx.metadata.commit.length > 0);
  assert(ctx.metadata.files_scanned > 0);
});

test('routes detected correctly', () => {
  assert(ctx.routes.length === 5, `expected 5 routes, got ${ctx.routes.length}`);
  const routePaths = ctx.routes.map(r => r.route);
  assert(routePaths.includes('/book'));
  assert(routePaths.includes('/book/barber'));
  assert(routePaths.includes('/book/confirm'));
  assert(routePaths.includes('/book/time'));
  assert(routePaths.includes('/book/success'));
});

test('routes are sorted alphabetically', () => {
  const routePaths = ctx.routes.map(r => r.route);
  const sorted = [...routePaths].sort();
  assert(JSON.stringify(routePaths) === JSON.stringify(sorted), 'routes should be sorted');
});

test('component graph has entries', () => {
  const keys = Object.keys(ctx.component_graph);
  assert(keys.length > 0, 'component_graph should not be empty');
});

test('state management detected', () => {
  assert(ctx.state_management.patterns_used.includes('useState'));
  assert(ctx.state_management.patterns_used.includes('fetch'));
});

test('API endpoints extracted', () => {
  assert(ctx.api_endpoints.called_from_booking.length > 0, 'should detect API calls');
  assert(ctx.api_endpoints.called_from_booking.some(e => e.includes('/api/services')));
  assert(ctx.api_endpoints.called_from_booking.some(e => e.includes('/api/appointments')));
});

test('API endpoints are sorted', () => {
  const eps = ctx.api_endpoints.called_from_booking;
  const sorted = [...eps].sort();
  assert(JSON.stringify(eps) === JSON.stringify(sorted));
});

test('i18n keys extracted', () => {
  assert(ctx.i18n.keys_used_in_booking.length > 0, 'should detect i18n keys');
  assert(ctx.i18n.locales.length === 3);
});

test('i18n keys are sorted', () => {
  const keys = ctx.i18n.keys_used_in_booking;
  const sorted = [...keys].sort();
  assert(JSON.stringify(keys) === JSON.stringify(sorted));
});

test('analytics events extracted', () => {
  assert(ctx.analytics.events_used_in_booking.length > 0);
  assert(ctx.analytics.events_used_in_booking.includes('booking_step_view'));
  assert(ctx.analytics.events_used_in_booking.includes('booking_completed'));
});

test('analytics defined events extracted', () => {
  assert(ctx.analytics.defined_events.length === 3);
  assert(ctx.analytics.defined_events.includes('booking_step_view'));
});

test('UX signals detected', () => {
  assert(Object.keys(ctx.ux_signals.patterns_detected).length > 0);
  assert('form' in ctx.ux_signals.patterns_detected);
});

test('Prisma models extracted', () => {
  assert(ctx.prisma_models.includes('Appointment'));
  assert(ctx.prisma_models.includes('Customer'));
  assert(ctx.prisma_models.includes('Service'));
});

test('Prisma models are sorted', () => {
  const models = ctx.prisma_models;
  const sorted = [...models].sort();
  assert(JSON.stringify(models) === JSON.stringify(sorted));
});

console.log('--- summary markdown ---');

test('summary contains routes table', () => {
  const md = fs.readFileSync(path.join(tmpDir, '.claw', 'context', 'booking-flow.summary.md'), 'utf8');
  assert(md.includes('## Routes'));
  assert(md.includes('/book'));
  assert(md.includes('/book/confirm'));
});

test('summary contains analytics section', () => {
  const md = fs.readFileSync(path.join(tmpDir, '.claw', 'context', 'booking-flow.summary.md'), 'utf8');
  assert(md.includes('## Analytics Events'));
  assert(md.includes('booking_step_view'));
});

console.log('--- files list ---');

test('files.txt contains booking pages', () => {
  const filesList = fs.readFileSync(path.join(tmpDir, '.claw', 'context', 'booking-flow.files.txt'), 'utf8');
  assert(filesList.includes('src/app/book/page.tsx'));
  assert(filesList.includes('src/app/book/confirm/page.tsx'));
});

test('files.txt is sorted', () => {
  const lines = fs.readFileSync(path.join(tmpDir, '.claw', 'context', 'booking-flow.files.txt'), 'utf8').trim().split('\n');
  const sorted = [...lines].sort();
  assert(JSON.stringify(lines) === JSON.stringify(sorted));
});

console.log('--- determinism ---');

test('running twice produces identical JSON', () => {
  // Run again
  runCli();
  const ctx2 = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claw', 'context', 'booking-flow.context.json'), 'utf8'));
  // Compare key structure (commit will be same since no new commits)
  assert(JSON.stringify(ctx.routes) === JSON.stringify(ctx2.routes), 'routes should match');
  assert(JSON.stringify(ctx.api_endpoints) === JSON.stringify(ctx2.api_endpoints), 'api_endpoints should match');
  assert(JSON.stringify(ctx.i18n) === JSON.stringify(ctx2.i18n), 'i18n should match');
});

console.log('--- missing .claw ---');

test('fails if .claw is missing', () => {
  const noClawDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-ctx-noclaw-'));
  fs.mkdirSync(path.join(noClawDir, 'src', 'app', 'book'), { recursive: true });
  try {
    execSync(`node "${SCRIPT}" --focus booking-flow`, { encoding: 'utf8', env: { ...process.env, WORKSPACE_ROOT: noClawDir }, stdio: 'pipe' });
    assert(false, 'should have thrown');
  } catch (e) {
    assert(e.status !== 0);
  } finally {
    fs.rmSync(noClawDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

cleanup();
console.log(`\n========================================`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`========================================\n`);
process.exit(failed > 0 ? 1 : 0);
