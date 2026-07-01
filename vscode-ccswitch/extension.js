'use strict';
// Thin VS Code companion for ccswitch. The VS Code Claude Code extension shares
// the CLI's credential store, so switching via ccswitch switches it too — this
// extension only adds a status-bar indicator and a QuickPick to trigger it.
const vscode = require('vscode');
const cp = require('child_process');

let statusItem = null;

function ccswitchBin() {
  return vscode.workspace.getConfiguration('ccswitch').get('path') || 'ccswitch';
}

function runJson(args) {
  return new Promise(function (resolve, reject) {
    cp.execFile(ccswitchBin(), args.concat(['--json']), { timeout: 15000 }, function (err, stdout) {
      try { resolve(JSON.parse(String(stdout).trim().split('\n').pop())); }
      catch (e) { reject(err || e); }
    });
  });
}

async function refreshStatus() {
  if (!statusItem) return;
  try {
    const st = await runJson(['status']);
    const email = (st.cli && st.cli.email) || null;
    statusItem.text = '$(account) ' + (email ? email.split('@')[0] : 'not logged in');
    statusItem.tooltip = 'Claude account (ccswitch)\nCLI: ' + ((st.cli && st.cli.email) || '—') +
      (st.app ? '\nDesktop app: ' + (st.app.email || st.app.name) : '') + '\n\nClick to switch';
    statusItem.show();
  } catch (e) {
    statusItem.text = '$(account) ccswitch?';
    statusItem.tooltip = 'ccswitch not found or failed — set "ccswitch.path" in settings.\n' + (e && e.message ? e.message : '');
    statusItem.show();
  }
}

async function switchAccount() {
  let list;
  try { list = await runJson(['list']); }
  catch (e) {
    vscode.window.showErrorMessage('ccswitch failed: ' + (e && e.message ? e.message : e) + ' — is ccswitch installed and on PATH?');
    return;
  }
  const accounts = (list.accounts || []);
  if (!accounts.length) {
    vscode.window.showWarningMessage("No saved Claude accounts yet — run 'ccswitch add' in a terminal while logged in.");
    return;
  }
  const items = accounts.map(function (a) {
    return {
      label: (a.activeCli ? '$(check) ' : '') + (a.email || a.name),
      description: '[cli ' + (a.cliCaptured ? '✓' : '—') + ' | app ' + (a.appCaptured ? '✓' : '—') + ']' + (a.activeCli ? '  (active)' : ''),
      name: a.name,
      active: a.activeCli,
    };
  });
  const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Switch Claude account to…' });
  if (!pick || pick.active) return;

  const choice = await vscode.window.showWarningMessage(
    'Switch Claude account to ' + pick.label.replace('$(check) ', '') + '? ' +
    'If the Claude desktop app is open it will be closed and reopened.',
    { modal: true }, 'Switch');
  if (choice !== 'Switch') return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Switching Claude account…' },
    function () {
      return new Promise(function (resolve) {
        cp.execFile(ccswitchBin(), [pick.name, '--restart', '--json'], { timeout: 60000 }, function (err, stdout, stderr) {
          if (err) {
            vscode.window.showErrorMessage('Switch failed: ' + (String(stderr).trim() || err.message));
          } else {
            vscode.window.showInformationMessage(
              'Switched to ' + pick.label.replace('$(check) ', '') + '. Reload the window so the Claude extension picks it up.',
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

function activate(context) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'ccswitch.switch';
  context.subscriptions.push(statusItem);
  context.subscriptions.push(vscode.commands.registerCommand('ccswitch.switch', switchAccount));
  context.subscriptions.push(vscode.commands.registerCommand('ccswitch.refresh', refreshStatus));
  refreshStatus();
  const timer = setInterval(refreshStatus, 60000);
  context.subscriptions.push({ dispose: function () { clearInterval(timer); } });
}

function deactivate() {}

module.exports = { activate: activate, deactivate: deactivate };
