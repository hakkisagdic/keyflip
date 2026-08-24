// Multi-file transaction: snapshot a set of files' bytes (or note absence)
// before a grouped edit, and restore ALL of them if anything throws — so a
// half-applied change (e.g. new credential written but pointer write failed,
// or a desktop config+cookie swap that died midway) never survives.
import fs from 'fs';

function snapshot(files) {
  return files.map(function (f) {
    try {
      return { path: f, existed: true, data: fs.readFileSync(f) };
    } catch (e) {
      return { path: f, existed: false, data: null };
    }
  });
}

function restore(snaps) {
  snaps.forEach(function (s) {
    try {
      if (s.existed) fs.writeFileSync(s.path, s.data);
      else fs.rmSync(s.path, { force: true });
    } catch (e) {
      /* best effort — restore as much as possible */
    }
  });
}

// Run fn(); if it throws, roll every listed file back to its pre-run bytes and
// rethrow the original error. Returns fn()'s result on success.
function withRollback(files, fn) {
  const snaps = snapshot(files);
  try {
    return fn();
  } catch (e) {
    restore(snaps);
    throw e;
  }
}

// Async variant for flows that await.
async function withRollbackAsync(files, fn) {
  const snaps = snapshot(files);
  try {
    return await fn();
  } catch (e) {
    restore(snaps);
    throw e;
  }
}

export { snapshot, restore, withRollback, withRollbackAsync };
