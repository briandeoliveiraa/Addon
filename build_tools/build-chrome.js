#!/usr/bin/env node
/*
 * ClearURLs
 * Copyright (c) 2017-2025 Kevin Röbert
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

/*
 * Assembles the Manifest V3 (Chrome) build in build/chrome.
 *
 *   node build_tools/build-chrome.js          # build/chrome (load it as "unpacked extension")
 *   node build_tools/build-chrome.js --zip    # additionally build/ClearURLs-chrome.zip
 *
 * The Chrome build shares all source files with the Firefox build; only the
 * manifest differs (manifest.chrome.json becomes manifest.json).
 */
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'build', 'chrome');
const zip = process.argv.includes('--zip');

const include = [
    'clearurls.js',
    'browser-polyfill.js',
    'LICENSE',
    'img',
    'external_js',
    'html',
    'core_js',
    'css',
    'fonts',
    '_locales'
];

const exclude = (file) => file.endsWith('.d.ts') || path.basename(file) === '.DS_Store';

function copy(src, dest) {
    const stat = fs.statSync(src);

    if (stat.isDirectory()) {
        fs.mkdirSync(dest, {recursive: true});
        for (const entry of fs.readdirSync(src)) {
            copy(path.join(src, entry), path.join(dest, entry));
        }
    } else if (!exclude(src)) {
        fs.mkdirSync(path.dirname(dest), {recursive: true});
        fs.copyFileSync(src, dest);
    }
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.chrome.json'), 'utf8'));
const firefoxManifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

if (manifest.manifest_version !== 3) {
    throw new Error('manifest.chrome.json must be a Manifest V3 manifest');
}

if (manifest.version !== firefoxManifest.version) {
    console.warn(`Warning: manifest.chrome.json has version ${manifest.version}, manifest.json has ${firefoxManifest.version}`);
}

fs.rmSync(out, {recursive: true, force: true});
fs.mkdirSync(out, {recursive: true});

for (const entry of include) {
    copy(path.join(root, entry), path.join(out, entry));
}

fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// Every script the service worker imports has to exist
const worker = fs.readFileSync(path.join(out, manifest.background.service_worker), 'utf8');
for (const match of worker.matchAll(/"(\/[^"]+\.js)"/g)) {
    if (!fs.existsSync(path.join(out, match[1]))) {
        throw new Error(`Service worker imports a missing file: ${match[1]}`);
    }
}

console.log(`ClearURLs ${manifest.version} for Chrome built in ${path.relative(root, out)}`);

if (zip) {
    const archive = path.join(root, 'build', 'ClearURLs-chrome.zip');
    fs.rmSync(archive, {force: true});
    execFileSync('zip', ['-r', '-q', archive, '.'], {cwd: out, stdio: 'inherit'});
    console.log(`Packed into ${path.relative(root, archive)}`);
}
