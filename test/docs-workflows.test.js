// Verify README workflow references exist under .github/workflows/ and Publishing docs match publish.yml.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from './helpers.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSection(markdown, headingPrefix) {
  const startRe = new RegExp(`^## ${escapeRegExp(headingPrefix)}[^\\n]*$`, 'm');
  const startMatch = startRe.exec(markdown);
  if (!startMatch) return '';
  const fromHeading = markdown.slice(startMatch.index);
  const afterHeading = fromHeading.slice(startMatch[0].length);
  const nextMatch = /\r?\n## [^\n]+/.exec(afterHeading);
  return nextMatch ? fromHeading.slice(0, startMatch[0].length + nextMatch.index) : fromHeading;
}

function addMatches(target, text, regex) {
  let match;
  while ((match = regex.exec(text)) !== null) {
    target.add(match[1]);
  }
}

function extractWorkflowNames(markdown) {
  const names = new Set();
  addMatches(names, markdown, /\.github\/workflows\/([A-Za-z0-9._-]+\.ya?ml)/g);
  addMatches(names, markdown, /actions\/workflows\/([A-Za-z0-9._-]+\.ya?ml)/g);
  addMatches(names, markdown, /workflow\s+`([A-Za-z0-9._-]+\.ya?ml)`/gi);
  for (const heading of ['Publishing', 'Yayınlama']) {
    const section = extractSection(markdown, heading);
    if (section) {
      addMatches(names, section, /`(?:\.github\/workflows\/)?([A-Za-z0-9._-]+\.ya?ml)`/g);
    }
  }
  return Array.from(names).sort();
}

function isRegularFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findMissingWorkflows(repoRoot, docFiles) {
  const workflowsDir = path.join(repoRoot, '.github', 'workflows');
  const workflowsByDoc = {};
  const missing = [];
  for (const docFile of docFiles) {
    const content = fs.readFileSync(path.join(repoRoot, docFile), 'utf8');
    const names = extractWorkflowNames(content);
    workflowsByDoc[docFile] = names;
    for (const name of names) {
      if (!isRegularFile(path.join(workflowsDir, name))) {
        missing.push({ doc: docFile, workflow: name });
      }
    }
  }
  return { workflowsByDoc, missing };
}

function assertTokensInOrder(text, startAnchor, tokens, label) {
  let pos = text.indexOf(startAnchor);
  assert.notStrictEqual(pos, -1, `${label}: expected anchor "${startAnchor}"`);
  pos += startAnchor.length;
  for (const token of tokens) {
    const nextPos = text.indexOf(token, pos);
    assert.notStrictEqual(nextPos, -1, `${label}: expected token "${token}" after index ${pos}`);
    pos = nextPos + token.length;
  }
}

test('README.md and README.tr.md only reference existing .github/workflows/<name>.yml files', function () {
  const result = findMissingWorkflows(REPO_ROOT, ['README.md', 'README.tr.md']);
  for (const doc of ['README.md', 'README.tr.md']) {
    assert.ok(result.workflowsByDoc[doc].includes('ci.yml'), `${doc} must reference ci.yml`);
    assert.ok(result.workflowsByDoc[doc].includes('publish.yml'), `${doc} must reference publish.yml`);
  }
  assert.deepStrictEqual(result.missing, []);
});

test('findMissingWorkflows detects missing .github/workflows/<name>.yml references in temp fixtures', function () {
  const root = tmpdir();
  try {
    const wfDir = path.join(root, '.github', 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, 'ci.yml'), 'name: CI\n');
    fs.writeFileSync(path.join(wfDir, 'publish.yml'), 'name: Publish\n');
    fs.writeFileSync(
      path.join(root, 'README.md'),
      [
        '# Sample',
        '',
        '[![CI](https://example.invalid/actions/workflows/ci.yml/badge.svg)](https://example.invalid/actions/workflows/ci.yml)',
        '',
        '## Publishing (maintainers)',
        '',
        'Uses `.github/workflows/publish.yml`.',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(root, 'README.tr.md'),
      [
        '# Örnek',
        '',
        '## Yayınlama (geliştiriciler için)',
        '',
        'Burada `.github/workflows/missing-flow.yml` ve `ghost.yml` geçer.',
      ].join('\n'),
    );

    const cleanResult = findMissingWorkflows(root, ['README.md']);
    assert.deepStrictEqual(cleanResult.workflowsByDoc['README.md'], ['ci.yml', 'publish.yml']);
    assert.deepStrictEqual(cleanResult.missing, []);

    const brokenResult = findMissingWorkflows(root, ['README.tr.md']);
    assert.deepStrictEqual(brokenResult.workflowsByDoc['README.tr.md'], ['ghost.yml', 'missing-flow.yml']);
    assert.deepStrictEqual(brokenResult.missing, [
      { doc: 'README.tr.md', workflow: 'ghost.yml' },
      { doc: 'README.tr.md', workflow: 'missing-flow.yml' },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('README.md Publishing (maintainers) documents publish.yml flow and package.json name', function () {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  assert.strictEqual(readme.includes('release.yml'), false, 'README.md must not mention release.yml');

  const section = extractSection(readme, 'Publishing');
  assert.ok(section.length > 0, 'README.md must contain a Publishing section');
  assert.ok(
    section.includes('.github/workflows/publish.yml'),
    'README.md Publishing section must reference .github/workflows/publish.yml',
  );
  assertTokensInOrder(
    section,
    '.github/workflows/publish.yml',
    ['tag', 'test', 'audit', 'npm', 'GitHub Release'],
    'README.md Publishing',
  );
  assert.doesNotMatch(section, /@[a-z0-9._-]+\/keyflip/i);
  assert.match(section, new RegExp('npm publish --access public\\s+#\\s*creates\\s+' + escapeRegExp(pkg.name) + '\\b'));
});

test('README.tr.md Yayınlama section mirrors publish.yml flow and package.json name', function () {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const readmeTr = fs.readFileSync(path.join(REPO_ROOT, 'README.tr.md'), 'utf8');
  assert.strictEqual(readmeTr.includes('release.yml'), false, 'README.tr.md must not mention release.yml');

  const section = extractSection(readmeTr, 'Yayınlama');
  assert.ok(section.length > 0, 'README.tr.md must contain a Yayınlama section');
  assert.ok(
    section.includes('.github/workflows/publish.yml'),
    'README.tr.md Yayınlama section must reference .github/workflows/publish.yml',
  );
  assertTokensInOrder(
    section,
    '.github/workflows/publish.yml',
    ['etiket', 'test', 'audit', 'npm', 'GitHub Release'],
    'README.tr.md Yayınlama',
  );
  assert.doesNotMatch(section, /@[a-z0-9._-]+\/keyflip/i);
  assert.match(section, new RegExp('npm publish --access public\\s+#\\s*' + escapeRegExp(pkg.name) + '\\b'));
});
