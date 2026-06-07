#!/usr/bin/env node
/**
 * Copies bundled library files from node_modules into extension/lib/
 * Run once after: npm install
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LIB  = path.join(ROOT, 'extension', 'lib');

const libs = [
  // pdf.js — full text extraction from PDF files
  {
    src:  'node_modules/pdfjs-dist/build/pdf.min.js',
    dest: 'pdf.min.js'
  },
  {
    src:  'node_modules/pdfjs-dist/build/pdf.worker.min.js',
    dest: 'pdf.worker.min.js'
  },
  // mammoth.js — full text extraction from DOCX files
  {
    src:  'node_modules/mammoth/mammoth.browser.min.js',
    dest: 'mammoth.min.js'
  },
  // SheetJS — Excel export
  {
    src:  'node_modules/xlsx/dist/xlsx.full.min.js',
    dest: 'xlsx.min.js'
  }
];

fs.mkdirSync(LIB, { recursive: true });

let ok = true;
for (const lib of libs) {
  const srcPath  = path.join(ROOT, lib.src);
  const destPath = path.join(LIB, lib.dest);
  try {
    fs.copyFileSync(srcPath, destPath);
    console.log(`✓  ${lib.src}  →  extension/lib/${lib.dest}`);
  } catch (err) {
    console.error(`✗  Failed to copy ${lib.src}`);
    console.error(`   ${err.message}`);
    ok = false;
  }
}

if (!ok) {
  console.error('\nOne or more libraries failed to copy. Run "npm install" first.');
  process.exit(1);
}

console.log('\nAll libraries copied to extension/lib/');
