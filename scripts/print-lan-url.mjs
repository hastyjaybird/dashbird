import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { printLanUrl } from '../src/lib/lan-url.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const writeFileFlag = process.argv.includes('--write');

const url = printLanUrl();
if (!url) process.exit(1);

if (writeFileFlag) {
  const dataDir = path.join(root, 'public/data');
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, 'phone-lan-url.txt'), `${url}\n`, 'utf8');
}
