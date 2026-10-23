import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fail } from './util.js';

const ID = /^d-[0-9a-f]{8}$/;

/**
 * Drafts and the audit log live on local disk (default ~/.shoptet-admin-mcp, mode 0700).
 * They contain "before" snapshots of whatever you change (HTML codes, banners, prices),
 * but never credentials.
 */
export class Store {
  constructor(cfg) {
    this.cfg = cfg;
    this.dir = cfg.stateDir;
    this.drafts = path.join(this.dir, 'drafts');
    fs.mkdirSync(this.drafts, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.dir, 0o700); } catch { /* best effort on non-POSIX */ }
  }

  newId() { return 'd-' + crypto.randomBytes(4).toString('hex'); }

  file(id) {
    if (!ID.test(id ?? '')) fail('Invalid draft id.');
    return path.join(this.drafts, id + '.json');
  }

  save(draft) { fs.writeFileSync(this.file(draft.id), JSON.stringify(draft, null, 2), { mode: 0o600 }); }

  load(id) {
    const f = this.file(id);
    if (!fs.existsSync(f)) fail(`Draft ${id} not found.`);
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  }

  list() {
    return fs.readdirSync(this.drafts).filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.drafts, f), 'utf8')))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ id, kind, status, summary, createdAt }) => ({ id, kind, status, summary, createdAt }));
  }

  audit(entry) {
    const line = JSON.stringify({ at: new Date().toISOString(), host: this.cfg.host, ...entry }) + '\n';
    fs.appendFileSync(path.join(this.dir, 'audit.jsonl'), line, { mode: 0o600 });
  }
}
