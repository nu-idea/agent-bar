// Debug: print what the widget would show right now. `npm run dump`
const { collect } = require('./sessions');

const now = Date.now();
for (const s of collect(now)) {
  const ago = Math.round((now - s.lastActivity) / 1000);
  const ctx = s.context ? `${s.context.used}${s.context.window ? '/' + s.context.window : ''} (${s.context.kind})` : '-';
  console.log(`[${s.agent}${s.where ? ' / ' + s.where : ''}] ${s.status.padEnd(8)} ${(s.detail || '').padEnd(10)} ${String(ago).padStart(5)}s  ${ctx.padEnd(26)} ${s.model || ''}  ${s.title}  — ${s.cwd || ''}`);
  for (const c of s.children) console.log(`    └ ${c.type || 'agent'} ${c.status} ${c.title}`);
}
