import * as vscode from 'vscode';
import { compareCurrentFileWithAccount, changeAccount, uploadCurrentFile, compareAndUploadCurrentFile } from './commands';
import { isProduction, listAuthAccounts, readProjectDefaultAuthId, findSdfRoot } from './suitecloud';

let accountItem: vscode.StatusBarItem | undefined;
let projectWatcher: vscode.FileSystemWatcher | undefined;

async function refreshAccountStatusBar(): Promise<void> {
  try {
    if (!accountItem) return;
    const current = readProjectDefaultAuthId();
    if (!current) {
      accountItem.hide();
      return;
    }
    const prod = isProduction(current);
    accountItem.text = prod ? `$(warning) ${current}` : `$(cloud) ${current}`;
    accountItem.tooltip = prod ? 'Production account — click to change' : 'Click to change NetSuite account';
    accountItem.backgroundColor = prod ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    accountItem.command = 'ns.changeAccount';
    accountItem.show();
  } catch {
    if (accountItem) accountItem.hide();
  }
}

function ensureProjectWatcher(context: vscode.ExtensionContext) {
  try {
    const root = findSdfRoot();
    const pattern = new vscode.RelativePattern(root, 'project.json');
    if (projectWatcher) projectWatcher.dispose();
    projectWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    context.subscriptions.push(projectWatcher);
    projectWatcher.onDidChange(() => { refreshAccountStatusBar(); });
    projectWatcher.onDidCreate(() => { refreshAccountStatusBar(); });
    projectWatcher.onDidDelete(() => { refreshAccountStatusBar(); });
  } catch {
    // ignore when there is no active SuiteCloud project
  }
}

export function activate(context: vscode.ExtensionContext) {
  const compareCmd = vscode.commands.registerCommand('ns.compareCurrentFileWithAccount', async () => {
    await runCommand(async (progress, token) => {
      await compareCurrentFileWithAccount(progress, token);
    }, 'Compare failed');
  });

  context.subscriptions.push(compareCmd);

  const uploadCmd = vscode.commands.registerCommand('ns.uploadCurrentFileToAccount', async () => {
    await runCommand(async (progress, token) => {
      await uploadCurrentFile(progress, token);
    }, 'Upload failed');
  });

  context.subscriptions.push(uploadCmd);

  const compareUploadCmd = vscode.commands.registerCommand('ns.compareAndUploadCurrentFileToAccount', async () => {
    await runCommand(async (progress, token) => {
      await compareAndUploadCurrentFile(progress, token);
    }, 'Compare & Upload failed');
  });

  context.subscriptions.push(compareUploadCmd);

  const changeAccountCmd = vscode.commands.registerCommand('ns.changeAccount', async () => {
    await runCommand(async (progress, token) => {
      await changeAccount(progress, token);
    }, 'Change account failed');
    await refreshAccountStatusBar();
  });

  context.subscriptions.push(changeAccountCmd);

  accountItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  accountItem.name = 'NetSuite Account';
  context.subscriptions.push(accountItem);
  refreshAccountStatusBar();
  ensureProjectWatcher(context);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
    refreshAccountStatusBar();
    ensureProjectWatcher(context);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    refreshAccountStatusBar();
    ensureProjectWatcher(context);
  }));
}

async function runCommand(cmd: (progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) => Promise<void>, errorMessage?: string) {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "NetSuite",
      cancellable: true,
    },
    async (progress, token) => {
      try {
        await cmd(progress, token);
      } catch (e: any) {
        // Swallow cancellations quietly
        if (token.isCancellationRequested || (e && (e.name === 'Canceled' || e.constructor?.name === 'CancellationError'))) {
          return;
        }
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`${errorMessage}: ${msg}`);
        return;
      }
    }
  );
}

export function deactivate() {}