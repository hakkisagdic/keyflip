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
let accountsProvider = null; // the sidebar tree of accounts

// Sidebar tree: one row per saved account (active flagged), click a row to switch to it.
function AccountsProvider() {
  const emitter = new vscode.EventEmitter();
  return {
    onDidChangeTreeData: emitter.event,
    refresh: function () { emitter.fire(); },
    getTreeItem: function (row) {
      const item = new vscode.TreeItem(row.label);
      item.description = row.description;
      item.tooltip = row.tooltip;
      item.iconPath = new vscode.ThemeIcon(row.active ? 'pass-filled' : 'account');
      item.contextValue = 'keyflipAccount';
      if (!row.active) item.command = { command: 'keyflip.switchTo', title: 'Switch', arguments: [row.name, row.label] };
      return item;
    },
    getChildren: async function () {
      try { return lib.accountTreeItems(await runJson(['list'])); }
      catch (e) { return []; }
    },
  };
}

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
    const st = await runJson(['status']);
    const view = lib.statusView(st);
    if (lib.mismatch(st)) {
      // Desktop app is on a DIFFERENT account than the CLI — warn (the switch may not have carried it).
      statusItem.text = '$(warning) ' + view.text.replace('$(account) ', '');
      statusItem.tooltip = view.tooltip + '\n\n⚠ The desktop app is on a different account than the CLI. Switch with --browser/--restart to align them.';
      statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      statusItem.text = view.text;
      statusItem.tooltip = view.tooltip;
      statusItem.backgroundColor = undefined;
    }
  } catch (e) {
    statusItem.text = '$(account) keyflip?';
    statusItem.tooltip = 'keyflip not found or failed — set "keyflip.path" in settings.\n' + (e && e.message ? e.message : '');
    statusItem.backgroundColor = undefined;
  }
  statusItem.show();
  if (accountsProvider) accountsProvider.refresh();
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
  return performSwitch(pick.name, name);
}

// Switch to a specific account by name (used by the QuickPick and the sidebar tree). Confirms first.
async function performSwitch(profileName, displayName) {
  const name = displayName || profileName;
  const choice = await vscode.window.showWarningMessage(
    'Switch Claude account to ' + name + '? If the Claude desktop app is open it will be closed and reopened.',
    { modal: true }, 'Switch');
  if (choice !== 'Switch') return;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Switching Claude account…' },
    function () {
      return new Promise(function (resolve) {
        cp.execFile(keyflipBin(), [profileName, '--restart', '--json'], { timeout: 60000 }, function (err, stdout, stderr) {
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

// Re-link a project's Claude chat history after its folder was moved/renamed. Defaults the NEW path
// to the current workspace folder; asks for the OLD absolute path. Runs `keyflip sessions rebind`.
async function rebindSession() {
  const folders = vscode.workspace.workspaceFolders || [];
  const newCwd = folders.length ? folders[0].uri.fsPath : null;
  const oldCwd = await vscode.window.showInputBox({
    title: 'keyflip: re-link chat history',
    prompt: 'OLD absolute path this project used to live at (its chats are keyed by it)',
    placeHolder: '/Users/you/Documents/OldName',
    ignoreFocusOut: true,
  });
  if (!oldCwd) return;
  const target = newCwd || (await vscode.window.showInputBox({ title: 'keyflip: re-link chat history', prompt: 'NEW absolute path (this project now)', ignoreFocusOut: true }));
  if (!target) return;
  cp.execFile(keyflipBin(), ['sessions', 'rebind', oldCwd, target, '--json'], { timeout: 30000 }, function (err, stdout, stderr) {
    if (err) { vscode.window.showErrorMessage('Rebind failed: ' + (String(stderr).trim() || err.message)); return; }
    const r = lib.parseJson(stdout);
    const moved = r && r.rebind && r.rebind.moved;
    vscode.window.showInformationMessage('Re-linked ' + (moved != null ? moved + ' transcript(s)' : 'chat history') + ' to ' + target + '. Reopen Claude to see them.');
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
  context.subscriptions.push(vscode.commands.registerCommand('keyflip.switchTo', function (name, display) { return performSwitch(name, display); }));
  context.subscriptions.push(vscode.commands.registerCommand('keyflip.rebind', rebindSession));
  context.subscriptions.push(vscode.commands.registerCommand('keyflip.refresh', refreshStatus));
  context.subscriptions.push(vscode.commands.registerCommand('keyflip.dashboard', openDashboard));
  context.subscriptions.push(vscode.commands.registerCommand('keyflip.status', function () { return showStatus(context); }));
  // Sidebar tree of accounts (Explorer view).
  accountsProvider = AccountsProvider();
  context.subscriptions.push(vscode.window.registerTreeDataProvider('keyflipAccounts', accountsProvider));
  refreshStatus();
  const timer = setInterval(refreshStatus, 60000);
  context.subscriptions.push({ dispose: function () { clearInterval(timer); } });
}

function deactivate() {}

module.exports = { activate: activate, deactivate: deactivate };
