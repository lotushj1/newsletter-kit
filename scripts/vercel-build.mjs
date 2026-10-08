import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const vite = spawnSync(
  process.execPath,
  ['./node_modules/vite/bin/vite.js', 'build', '--config', 'admin/vite.config.mjs'],
  { stdio: 'inherit' },
);
if (vite.status !== 0) process.exit(vite.status ?? 1);

mkdirSync('public/admin', { recursive: true });
cpSync('admin/dist', 'public/admin', { recursive: true });

if (process.env.VERCEL === '1') {
  const { globSync } = await import('node:fs');
  for (const file of globSync('**/*.{ts,tsx}')) {
    if (file.startsWith('src/') || file.startsWith('node_modules/') || file === 'app.ts') continue;
    rmSync(file, { force: true });
  }
}
