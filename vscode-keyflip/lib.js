'use strict';
// Pure, VS Code-INDEPENDENT core for the keyflip extension: output parsing + view-model
// shaping. Kept import-free (no `require('vscode')`) so it is unit-tested in keyflip's own
// `node --test` harness. The thin glue in extension.js wires these into the VS Code API and
// is intentionally not unit-tested.

// `keyflip --json` prints ONE JSON object to stdout (human text goes to stderr). Parse
// defensively: the whole trimmed body first, then fall back to the last JSON-parseable line.
function parseJson(stdout) {
  const s = String(stdout == null ? '' : stdout).trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { /* fall through to line scan */ }
  const lines = s.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch (e) { /* keep scanning upward */ }
  }
  return null;
}

// Short quota label from a list-account's usage window (utilization %), or '' when the
// account is expired/throttled/unknown or usage is unavailable. Mirrors `usage.fmt`.
function quotaLabel(usage, status) {
  if (status && status !== 'ok') return '';
  if (!usage) return '';
  if (usage.fiveHour && typeof usage.fiveHour.pct === 'number') return '5h ' + Math.round(usage.fiveHour.pct) + '%';
  if (usage.sevenDay && typeof usage.sevenDay.pct === 'number') return '7d ' + Math.round(usage.sevenDay.pct) + '%';
  return '';
}

// Status-bar view-model from `keyflip status --json` (network-free — CLI email + app + provider).
function statusView(status) {
  const cliEmail = (status && status.cli && status.cli.email) || null;
  const short = cliEmail ? cliEmail.split('@')[0] : 'not logged in';
  const lines = ['Claude account (keyflip)', 'CLI: ' + (cliEmail || '—')];
  if (status && status.app) lines.push('Desktop app: ' + (status.app.email || status.app.name || 'unknown'));
  if (status && status.provider) lines.push('Provider: ' + status.provider + ' (overrides the account for API calls)');
  lines.push('', 'Click to switch');
  return { text: '$(account) ' + short, tooltip: lines.join('\n') };
}

// QuickPick items from `keyflip list --json` (carries per-account capture + quota).
function accountItems(list) {
  const accounts = (list && list.accounts) || [];
  return accounts.map(function (a) {
    const q = quotaLabel(a.usage, a.usageStatus);
    return {
      label: (a.activeCli ? '$(check) ' : '') + (a.email || a.name),
      description: '[cli ' + (a.cliCaptured ? '✓' : '—') + ' | app ' + (a.appCaptured ? '✓' : '—') + ']'
        + (q ? '  ' + q : '') + (a.activeCli ? '  (active)' : ''),
      name: a.name,
      active: !!a.activeCli,
    };
  });
}

module.exports = { parseJson: parseJson, quotaLabel: quotaLabel, statusView: statusView, accountItems: accountItems };
