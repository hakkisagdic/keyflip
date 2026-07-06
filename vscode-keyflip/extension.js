'use strict';
// Thin VS Code companion for keyflip. The VS Code Claude Code extension shares the CLI's
// credential store, so switching via keyflip switches it too — this extension adds a
// status-bar indicator, a QuickPick to switch accounts, a one-click dashboard, and a
// status detail view. All logic that can be tested without VS Code lives in ./lib.js.
const vscode = require('vscode');
const cp = require('child_process');
const lib = require('./lib');

let statusItem = null;
let outChannel = null; // created once, reused (creating one per call would leak channels)

function keyflipBin() {
  return vscode.workspace.getConfiguration('keyflip').get('path') || 'keyflip';
}
// Shell-quote the binary for a terminal command line (a configured path may contain spaces).
function keyflipBinShell() {
  const bin = keyflipBin();
  return /\s/.test(bin) ? '"' + bin.replace(/"/g, '\\"') + '"' : bin;
}

function runJson(args) {
  return new Promise(function (resolve, reject) {
    cp.execFile(keyflipBin(), args.concat(['--json']), { timeout: 20000 }, function (err, stdout) {
      const parsed = lib.parseJson(stdout);
      if (parsed) return resolve(parsed);
      reject(err || new Error('keyflip returned no JSON'));
    });
  });
}

async function refreshStatus() {
  if (!statusItem) return;
  try {
    const view = lib.statusView(await runJson(['status']));
    statusItem.text = view.text;
    statusItem.tooltip = view.tooltip;
  } catch (e) {
    statusItem.text = '$(account) keyflip?';
    statusItem.tooltip = 'keyflip not found or failed — set "keyflip.path" in settings.\n' + (e && e.message ? e.message : '');
  }
  statusItem.show();
}

async function switchAccount() {
  let list;
  try { list = await runJson(['list']); }
  catch (e) {
    vscode.window.showErrorMessage('keyflip failed: ' + (e && e.message ? e.message : e) + ' — is keyflip installed and on PATH?');
    return;
  }
  const items = lib.accountItems(list);
  if (!items.length) {
    vscode.window.showWarningMessage("No saved Claude accounts yet — run 'keyflip add' in a terminal while logged in.");
    return;
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Switch Claude account to…' });
  if (!pick || pick.active) return;

  const name = pick.label.replace('$(check) ', '');
  const choice = await vscode.window.showWarningMessage(
    'Switch Claude account to ' + name + '? If the Claude desktop app is open it will be closed and reopened.',
    { modal: true }, 'Switch');
  if (choice !== 'Switch') return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Switching Claude account…' },
    function () {
      return new Promise(function (resolve) {
        cp.execFile(keyflipBin(), [pick.name, '--restart', '--json'], { timeout: 60000 }, function (err, stdout, stderr) {
          if (err) {
            vscode.window.showErrorMessage('Switch failed: ' + (String(stderr).trim() || err.message));
          } else {
            vscode.window.showInformationMessage(
              'Switched to ' + name + '. Reload the window so the Claude extension picks it up.',
              'Reload Window'
            ).then(function (btn) {
              if (btn === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
            });
          }
          refreshStatus().then(resolve, resolve);
        });
      });
    });
}

// Open keyflip's local dashboard. `keyflip panel` is a foreground loopback server, so it
// belongs in an integrated terminal (Ctrl-C stops it) rather than a spawned child.
function openDashboard() {
  const term = vscode.window.createTerminal('keyflip dashboard');
  term.show();
  term.sendText(keyflipBinShell() + ' panel --open');
}

// Full account status in a reused output channel (CLI + desktop app + active provider).
async function showStatus(context) {
  let st;
  try { st = await runJson(['status']); }
  catch (e) { vscode.window.showErrorMessage('keyflip status failed: ' + (e && e.message ? e.message : e)); return; }
  if (!outChannel) { outChannel = vscode.window.createOutputChannel('keyflip'); if (context) context.subscriptions.push(outChannel); }
  outChannel.clear();
  outChannel.appendLine('Claude Code (CLI): ' + ((st.cli && st.cli.email) || 'not logged in'));
  if (st.app) outChannel.appendLine('Desktop app:       ' + (st.app.email || st.app.name || 'unknown'));
  outChannel.appendLine('Active provider:   ' + (st.provider || '(none — using the account)'));
  outChannel.show(true);
}

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'keyflip.switch';
  context.subscriptions.push(statusItem);
  context.subscriptions.push(vscode.commands.registerCommand('keyflip.switch', switchAccount));
  context.subscriptions.push(vscode.commands.registerCommand('keyflip.refresh', refreshStatus));
  context.subscriptions.push(vscode.commands.registerCommand('keyflip.dashboard', openDashboard));
  context.subscriptions.push(vscode.commands.registerCommand('keyflip.status', function () { return showStatus(context); }));
  refreshStatus();
  const timer = setInterval(refreshStatus, 60000);
  context.subscriptions.push({ dispose: function () { clearInterval(timer); } });
}

function deactivate() {}

module.exports = { activate: activate, deactivate: deactivate };
