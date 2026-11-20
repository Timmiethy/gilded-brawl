// Copies the three.js files the renderer uses from node_modules into public/vendor/three/.
// The game has no bundler and its CSP forbids inline scripts (so no import map); this script rewrites
// the addons' bare `'three'` imports to the vendored module path instead.
// Run after changing the pinned `three` version: npm run vendor:three
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'node_modules', 'three');
const out = path.join(root, 'public', 'vendor', 'three');

const FILES = [
  'build/three.module.js',
  'build/three.core.js',
  'examples/jsm/postprocessing/EffectComposer.js',
  'examples/jsm/postprocessing/RenderPass.js',
  'examples/jsm/postprocessing/UnrealBloomPass.js',
  'examples/jsm/postprocessing/OutputPass.js',
  'examples/jsm/postprocessing/ShaderPass.js',
  'examples/jsm/postprocessing/MaskPass.js',
  'examples/jsm/postprocessing/Pass.js',
  'examples/jsm/shaders/CopyShader.js',
  'examples/jsm/shaders/LuminosityHighPassShader.js',
  'examples/jsm/shaders/OutputShader.js',
  'examples/jsm/environments/RoomEnvironment.js',
];

fs.rmSync(out, { recursive: true, force: true });
for (const rel of FILES) {
  const dest = path.join(out, rel.replace(/^build\//, '').replace(/^examples\/jsm\//, 'addons/'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let code = fs.readFileSync(path.join(src, rel), 'utf8');
  code = code.replace(/^(\s*(?:import|export)\b[^;]*?\bfrom\s*)'three'/gm, "$1'/vendor/three/three.module.js'");
  fs.writeFileSync(dest, code);
}
fs.copyFileSync(path.join(src, 'LICENSE'), path.join(out, 'LICENSE'));
const { version } = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(out, 'VERSION'), `${version}\n`);
console.log(`Vendored three@${version} (${FILES.length} files) into public/vendor/three/`);
