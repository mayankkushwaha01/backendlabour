import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const distEntry = path.join(__dirname, 'dist', 'server.js');
const tsxBin = path.join(__dirname, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const srcEntry = path.join(__dirname, 'src', 'server.ts');

if (fs.existsSync(distEntry)) {
  await import(distEntry);
} else if (fs.existsSync(tsxBin)) {
  const child = spawn(process.execPath, [tsxBin, srcEntry], { stdio: 'inherit' });
  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
} else {
  console.error('dist/server.js not found and tsx is not installed.');
  console.error('Run "npm run build:tsc" or install dev dependencies to run from src.');
  process.exit(1);
}
