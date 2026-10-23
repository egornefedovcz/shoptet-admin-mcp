import { HANDLERS } from './writers.js';
import { fail } from './util.js';

/**
 * Observed on a real admin: after saving the HTML code page, the same browser session could no longer edit
 * a banner (the React textarea reverted whatever was typed, even after reloading). A fresh browser fixes it.
 * The cause is unknown, so every write ends by discarding the browser; the next call logs in again.
 */
const freshBrowserAfter = async (s, fn) => { try { return await fn(); } finally { await s.close(); } };

/**
 * propose → apply → revert, with a draft on disk and an audit line for each step.
 * Applying is allowed once per draft and only within the draft's lifetime.
 */
export class Engine {
  constructor(session, store, cfg) { this.s = session; this.store = store; this.cfg = cfg; }

  async propose(kind, params) {
    const handler = HANDLERS[kind] ?? fail(`Unknown change kind: ${kind}`);
    return this.s.exclusive(async (s) => {
      const r = await handler.propose(s, params);
      const now = Date.now();
      const draft = {
        id: this.store.newId(), kind, status: 'proposed', summary: r.summary, plan: r.plan, before: r.before,
        revertNote: r.revertNote, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + this.cfg.draftTtlMs).toISOString(),
      };
      this.store.save(draft);
      this.store.audit({ event: 'propose', draft: draft.id, kind });
      return { draftId: draft.id, summary: draft.summary, revert: draft.revertNote, expiresAt: draft.expiresAt,
        next: 'Show this summary to the user. Only call shoptet_apply_change after they explicitly agree.' };
    });
  }

  async apply(id) {
    const d = this.store.load(id);
    if (d.status !== 'proposed') fail(`Draft ${id} is "${d.status}"; only proposed drafts can be applied.`);
    if (new Date(d.expiresAt) < new Date()) fail(`Draft ${id} expired. Propose the change again.`);
    d.status = 'applying'; this.store.save(d);   // blocks a second apply while this one runs
    return this.s.exclusive((s) => freshBrowserAfter(s, async () => {
      try {
        const r = await HANDLERS[d.kind].apply(s, d);
        d.status = 'applied'; d.result = r.message; d.appliedAt = new Date().toISOString();
        this.store.save(d); this.store.audit({ event: 'apply', draft: id, kind: d.kind, ok: true });
        return { draftId: id, ok: true, message: r.message, revert: `shoptet_revert_change with draft_id "${id}"` };
      } catch (e) {
        d.status = 'failed'; d.error = e.message; this.store.save(d);
        this.store.audit({ event: 'apply', draft: id, kind: d.kind, ok: false, error: e.message });
        throw e;
      }
    }));
  }

  async revert(id) {
    const d = this.store.load(id);
    if (!['applied', 'failed', 'applying'].includes(d.status)) fail(`Draft ${id} is "${d.status}"; nothing to revert.`);
    return this.s.exclusive((s) => freshBrowserAfter(s, async () => {
      try {
        const r = await HANDLERS[d.kind].revert(s, d);
        d.status = 'reverted'; d.revertedAt = new Date().toISOString(); this.store.save(d);
        this.store.audit({ event: 'revert', draft: id, kind: d.kind, ok: true });
        return { draftId: id, ok: true, message: r.message };
      } catch (e) {
        this.store.audit({ event: 'revert', draft: id, kind: d.kind, ok: false, error: e.message });
        throw e;
      }
    }));
  }
}
