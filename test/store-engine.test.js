import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { HANDLERS } from '../src/writers.js';

const mk = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sam-'));
  const cfg = { host: 'demo.myshoptet.com', stateDir: dir, draftTtlMs: 60000 };
  const session = { exclusive: (fn) => fn(session), close: async () => {} };
  return { dir, cfg, store: new Store(cfg), engine: new Engine(session, new Store(cfg), cfg) };
};

test('draft ids cannot escape the drafts directory', () => {
  const { store } = mk();
  for (const bad of ['../x', 'd-../../etc', 'd-zzzzzzzz', '', undefined]) assert.throws(() => store.file(bad), /Invalid draft id/);
});

test('state directory is private and drafts hold no credentials', () => {
  const { dir, store } = mk();
  if (process.platform !== 'win32') assert.equal(fs.statSync(dir).mode & 0o077, 0);
  const id = store.newId();
  store.save({ id, kind: 'x', status: 'proposed', summary: 's', createdAt: new Date().toISOString() });
  assert.equal(store.load(id).id, id);
});

test('propose → apply once → revert; second apply is refused', async () => {
  const { engine, store } = mk();
  const calls = [];
  HANDLERS.fake = {
    propose: async () => ({ summary: 'fake', plan: {}, before: null, revertNote: 'r' }),
    apply: async () => { calls.push('apply'); return { message: 'done' }; },
    revert: async () => { calls.push('revert'); return { message: 'undone' }; },
  };
  const p = await engine.propose('fake', {});
  assert.equal(store.load(p.draftId).status, 'proposed');
  await engine.apply(p.draftId);
  assert.equal(store.load(p.draftId).status, 'applied');
  await assert.rejects(engine.apply(p.draftId), /only proposed drafts/);
  await engine.revert(p.draftId);
  assert.deepEqual(calls, ['apply', 'revert']);
  await assert.rejects(engine.revert(p.draftId), /nothing to revert/);
  delete HANDLERS.fake;
});

test('an expired draft cannot be applied', async () => {
  const { engine, store } = mk();
  HANDLERS.fake = { propose: async () => ({ summary: 'f', plan: {}, before: null }), apply: async () => ({ message: 'x' }), revert: async () => ({ message: 'x' }) };
  const p = await engine.propose('fake', {});
  const d = store.load(p.draftId); d.expiresAt = new Date(Date.now() - 1000).toISOString(); store.save(d);
  await assert.rejects(engine.apply(p.draftId), /expired/);
  delete HANDLERS.fake;
});

test('a failed apply is recorded and can be reverted', async () => {
  const { engine, store } = mk();
  HANDLERS.fake = { propose: async () => ({ summary: 'f', plan: {}, before: null }), apply: async () => { throw new Error('boom'); }, revert: async () => ({ message: 'cleaned' }) };
  const p = await engine.propose('fake', {});
  await assert.rejects(engine.apply(p.draftId), /boom/);
  assert.equal(store.load(p.draftId).status, 'failed');
  await engine.revert(p.draftId);
  assert.equal(store.load(p.draftId).status, 'reverted');
  delete HANDLERS.fake;
});

test('unknown change kinds are rejected', async () => {
  const { engine } = mk();
  await assert.rejects(engine.propose('rm-rf', {}), /Unknown change kind/);
});

test('audit log is append-only JSONL without secrets', () => {
  const { dir, store } = mk();
  store.audit({ event: 'apply', draft: 'd-00000000', ok: true });
  const line = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8').trim();
  assert.equal(JSON.parse(line).event, 'apply');
});
