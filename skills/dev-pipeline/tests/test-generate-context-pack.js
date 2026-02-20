#!/usr/bin/env node
'use strict';

/**
 * Tests for generate-context-pack.js
 *
 * Creates a minimal mock project structure in a tmpdir,
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
  // Create minimal project structure under src/app/checkout
  const focusDir = path.join(tmpDir, 'src', 'app', 'checkout');
  fs.mkdirSync(focusDir, { recursive: true });
  fs.mkdirSync(path.join(focusDir, 'payment'), { recursive: true });
  fs.mkdirSync(path.join(focusDir, 'confirm'), { recursive: true });
  fs.mkdirSync(path.join(focusDir, 'summary'), { recursive: true });
  fs.mkdirSync(path.join(focusDir, 'success'), { recursive: true });
  fs.mkdirSync(path.join(focusDir, 'components'), { recursive: true });

  // Page files with realistic content
  fs.writeFileSync(path.join(focusDir, 'page.tsx'), `
import { useState, useEffect } from 'react';
import { StickyFooter } from './components/StickyFooter';
import styles from './checkout.module.css';

export default function CartPage() {
  const [items, setItems] = useState([]);
  const { t } = useLanguage();

  useEffect(() => {
    fetch('/api/products?shopId=\${shopId}').then(r => r.json()).then(setItems);
  }, []);

  trackCheckoutEvent('step_view', { stepId: 'cart' });

  return <form onSubmit={handleSubmit}><div>{t.selectItems}</div><div>{t.allItems}</div></form>;
}
`);

  fs.writeFileSync(path.join(focusDir, 'payment', 'page.tsx'), `
import { useState, useEffect } from 'react';
import { ProgressBar } from '../components/ProgressBar';
export default function PaymentPage() {
  const [methods, setMethods] = useState([]);
  useEffect(() => { fetch('/api/payments?shopId=\${id}'); }, []);
  trackCheckoutEvent('step_view', { stepId: 'payment' });
  return <div>{t.selectPayment}</div>;
}
`);

  fs.writeFileSync(path.join(focusDir, 'summary', 'page.tsx'), `
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ProgressBar } from '../components/ProgressBar';
export default function SummaryPage() {
  const [order, setOrder] = useState([]);
  const isLoading = true;
  useEffect(() => { fetch('/api/orders/preview?date=\${d}'); }, []);
  trackCheckoutEvent('review_order', { stepId: 'summary' });
  return <div>{t.reviewOrder}</div>;
}
`);

  fs.writeFileSync(path.join(focusDir, 'confirm', 'page.tsx'), `
import { useState, useEffect, useRef } from 'react';
import { StickyFooter } from '../components/StickyFooter';
export default function ConfirmPage() {
  const [error, setError] = useState(null);
  const isLoading = false;
  const disabled = !valid;
  useEffect(() => { fetch('/api/customers'); fetch('/api/orders'); }, []);
  const emailValid = /^[^@]+@[^@]+/.test(email);
  trackCheckoutEvent('order_placed', { stepId: 'confirm' });
  return <form>{t.confirmOrder} {t.email} {t.emailRequired} {t.firstName}</form>;
}
`);

  fs.writeFileSync(path.join(focusDir, 'success', 'page.tsx'), `
import { useEffect, useState, useCallback } from 'react';
export default function SuccessPage() {
  const [order, setOrder] = useState(null);
  useEffect(() => { fetch('/api/orders/\${id}'); }, []);
  return <div>{t.orderConfirmed}</div>;
}
`);

  fs.writeFileSync(path.join(focusDir, 'layout.tsx'), `
export default function CheckoutLayout({ children }) { return <div>{children}</div>; }
`);

  fs.writeFileSync(path.join(focusDir, 'components', 'ProgressBar.tsx'), `
export function ProgressBar({ step }) { return <div>Step {step}</div>; }
`);

  fs.writeFileSync(path.join(focusDir, 'components', 'StickyFooter.tsx'), `
export function StickyFooter({ children }) { return <footer>{children}</footer>; }
`);

  // API routes
  const apiDir = path.join(tmpDir, 'src', 'app', 'api');
  fs.mkdirSync(path.join(apiDir, 'orders'), { recursive: true });
  fs.mkdirSync(path.join(apiDir, 'products'), { recursive: true });
  fs.mkdirSync(path.join(apiDir, 'customers'), { recursive: true });
  fs.writeFileSync(path.join(apiDir, 'orders', 'route.ts'), 'export async function GET() {}');
  fs.writeFileSync(path.join(apiDir, 'products', 'route.ts'), 'export async function GET() {}');
  fs.writeFileSync(path.join(apiDir, 'customers', 'route.ts'), 'export async function GET() {}');

  // Analytics
  fs.mkdirSync(path.join(tmpDir, 'src', 'lib', 'analytics'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'src', 'lib', 'analytics', 'events.ts'), `
export type CheckoutEventName = 'step_view' | 'order_placed' | 'review_order';
export function trackCheckoutEvent(name: CheckoutEventName, payload: any) {}
`);

  // i18n
  fs.mkdirSync(path.join(tmpDir, 'src', 'lib', 'i18n'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'src', 'lib', 'i18n', 'translations.ts'), `
export interface Translations {
  selectItems: string;
  allItems: string;
  selectPayment: string;
  reviewOrder: string;
  confirmOrder: string;
  email: string;
  emailRequired: string;
  firstName: string;
  orderConfirmed: string;
  loading: string;
  goBack: string;
}
`);

  // Prisma
  fs.mkdirSync(path.join(tmpDir, 'prisma'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'prisma', 'schema.prisma'), `
model Order {
  id String @id
}
model Customer {
  id String @id
}
model Product {
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
  const cmd = `node "${SCRIPT}" --focus checkout ${extraArgs || ''}`;
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

test('exits non-zero for missing focus directory', () => {
  try {
    execSync(`node "${SCRIPT}" --focus nonexistent-area`, { encoding: 'utf8', env: { ...process.env, WORKSPACE_ROOT: tmpDir }, stdio: 'pipe' });
    assert(false, 'should have thrown');
  } catch (e) {
    assert(e.status !== 0);
  }
});

test('succeeds for checkout focus', () => {
  const out = runCli();
  const result = JSON.parse(out);
  assert(result.ok === true, 'ok should be true');
  assert(result.focus === 'checkout');
});

console.log('--- output files ---');

test('creates checkout.context.json', () => {
  assert(fs.existsSync(path.join(tmpDir, '.claw', 'context', 'checkout.context.json')));
});

test('creates checkout.summary.md', () => {
  assert(fs.existsSync(path.join(tmpDir, '.claw', 'context', 'checkout.summary.md')));
});

test('creates checkout.files.txt', () => {
  assert(fs.existsSync(path.join(tmpDir, '.claw', 'context', 'checkout.files.txt')));
});

console.log('--- context JSON structure ---');

const ctx = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claw', 'context', 'checkout.context.json'), 'utf8'));

test('metadata has focus and commit', () => {
  assert(ctx.metadata.focus === 'checkout');
  assert(typeof ctx.metadata.commit === 'string' && ctx.metadata.commit.length > 0);
  assert(ctx.metadata.files_scanned > 0);
});

test('routes detected correctly', () => {
  assert(ctx.routes.length === 5, `expected 5 routes, got ${ctx.routes.length}`);
  const routePaths = ctx.routes.map(r => r.route);
  assert(routePaths.includes('/checkout'));
  assert(routePaths.includes('/checkout/payment'));
  assert(routePaths.includes('/checkout/confirm'));
  assert(routePaths.includes('/checkout/summary'));
  assert(routePaths.includes('/checkout/success'));
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
  assert(ctx.api_endpoints.called_from_focus.length > 0, 'should detect API calls');
  assert(ctx.api_endpoints.called_from_focus.some(e => e.includes('/api/products')));
  assert(ctx.api_endpoints.called_from_focus.some(e => e.includes('/api/orders')));
});

test('API endpoints are sorted', () => {
  const eps = ctx.api_endpoints.called_from_focus;
  const sorted = [...eps].sort();
  assert(JSON.stringify(eps) === JSON.stringify(sorted));
});

test('i18n keys extracted', () => {
  assert(ctx.i18n.keys_used_in_focus.length > 0, 'should detect i18n keys');
});

test('i18n keys are sorted', () => {
  const keys = ctx.i18n.keys_used_in_focus;
  const sorted = [...keys].sort();
  assert(JSON.stringify(keys) === JSON.stringify(sorted));
});

test('analytics events extracted', () => {
  assert(ctx.analytics.events_used_in_focus.length > 0);
  assert(ctx.analytics.events_used_in_focus.includes('step_view'));
  assert(ctx.analytics.events_used_in_focus.includes('order_placed'));
});

test('analytics defined events extracted', () => {
  assert(ctx.analytics.defined_events.length === 3);
  assert(ctx.analytics.defined_events.includes('step_view'));
});

test('UX signals detected', () => {
  assert(Object.keys(ctx.ux_signals.patterns_detected).length > 0);
  assert('form' in ctx.ux_signals.patterns_detected);
});

test('Prisma models extracted', () => {
  assert(ctx.prisma_models.includes('Order'));
  assert(ctx.prisma_models.includes('Customer'));
  assert(ctx.prisma_models.includes('Product'));
});

test('Prisma models are sorted', () => {
  const models = ctx.prisma_models;
  const sorted = [...models].sort();
  assert(JSON.stringify(models) === JSON.stringify(sorted));
});

console.log('--- summary markdown ---');

test('summary contains routes table', () => {
  const md = fs.readFileSync(path.join(tmpDir, '.claw', 'context', 'checkout.summary.md'), 'utf8');
  assert(md.includes('## Routes'));
  assert(md.includes('/checkout'));
  assert(md.includes('/checkout/confirm'));
});

test('summary contains analytics section', () => {
  const md = fs.readFileSync(path.join(tmpDir, '.claw', 'context', 'checkout.summary.md'), 'utf8');
  assert(md.includes('## Analytics Events'));
  assert(md.includes('step_view'));
});

console.log('--- files list ---');

test('files.txt contains focus pages', () => {
  const filesList = fs.readFileSync(path.join(tmpDir, '.claw', 'context', 'checkout.files.txt'), 'utf8');
  assert(filesList.includes('src/app/checkout/page.tsx'));
  assert(filesList.includes('src/app/checkout/confirm/page.tsx'));
});

test('files.txt is sorted', () => {
  const lines = fs.readFileSync(path.join(tmpDir, '.claw', 'context', 'checkout.files.txt'), 'utf8').trim().split('\n');
  const sorted = [...lines].sort();
  assert(JSON.stringify(lines) === JSON.stringify(sorted));
});

console.log('--- determinism ---');

test('running twice produces identical JSON', () => {
  runCli();
  const ctx2 = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claw', 'context', 'checkout.context.json'), 'utf8'));
  assert(JSON.stringify(ctx.routes) === JSON.stringify(ctx2.routes), 'routes should match');
  assert(JSON.stringify(ctx.api_endpoints) === JSON.stringify(ctx2.api_endpoints), 'api_endpoints should match');
  assert(JSON.stringify(ctx.i18n) === JSON.stringify(ctx2.i18n), 'i18n should match');
});

console.log('--- generic field names ---');

test('uses focus_pages not domain-specific names', () => {
  assert(Array.isArray(ctx.files.focus_pages), 'should have focus_pages');
  assert(Array.isArray(ctx.files.focus_components), 'should have focus_components');
  assert(ctx.files.focus_pages.length > 0);
});

test('uses called_from_focus not domain-specific names', () => {
  assert(Array.isArray(ctx.api_endpoints.called_from_focus), 'should have called_from_focus');
});

test('uses keys_used_in_focus not domain-specific names', () => {
  assert(Array.isArray(ctx.i18n.keys_used_in_focus), 'should have keys_used_in_focus');
});

test('uses events_used_in_focus not domain-specific names', () => {
  assert(Array.isArray(ctx.analytics.events_used_in_focus), 'should have events_used_in_focus');
});

console.log('--- missing .claw ---');

test('fails if .claw is missing', () => {
  const noClawDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-ctx-noclaw-'));
  fs.mkdirSync(path.join(noClawDir, 'src', 'app', 'checkout'), { recursive: true });
  try {
    execSync(`node "${SCRIPT}" --focus checkout`, { encoding: 'utf8', env: { ...process.env, WORKSPACE_ROOT: noClawDir }, stdio: 'pipe' });
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
