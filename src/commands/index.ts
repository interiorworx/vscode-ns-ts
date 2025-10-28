import * as vscode from 'vscode';
import { getPathForCurrentFile, isObjectXmlFile } from '../utils';
import { getOutputChannel, listAuthAccounts, readProjectDefaultAuthId, setProjectDefaultAuthId } from '../suitecloud';
import { ensureActiveFileSaved } from '../utils';
import { compareScriptWithAccount, uploadScriptFile } from './file-upload';
import { compareCurrentObjectWithAccount, uploadCurrentObject } from './object-upload';

export async function changeAccount(progress: vscode.Progress<{ message?: string; increment?: number }>, _token: vscode.CancellationToken) {
    const out = getOutputChannel();
    progress.report({ message: 'Retrieving SuiteCloud accounts...' });
    const accounts = await listAuthAccounts();
    if (!accounts.length) {
        vscode.window.showErrorMessage('No SuiteCloud auth accounts found. Run "suitecloud account:manageauth" to add one.');
        return;
    }

    const current = readProjectDefaultAuthId();
    const items = accounts.map(a => {
        const parts = a.raw.split('|').map(s => s.trim());
        const description = parts.slice(1).join(' | ');
        return { label: a.authId, description: description || undefined } as vscode.QuickPickItem;
    });
    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: current ? `Select account (current: ${current})` : 'Select account',
        matchOnDescription: true,
    });
    if (!picked) return;

    progress.report({ message: `Setting defaultAuthId to ${picked.label}...` });
    setProjectDefaultAuthId(picked.label);
    out.appendLine(`[account] Changed defaultAuthId to ${picked.label}`);
    vscode.window.showInformationMessage(`NetSuite account set to ${picked.label}`);
}

export async function compareCurrentFileWithAccount(progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken, compile: boolean = true) {
    await ensureActiveFileSaved();
    const localPath = getPathForCurrentFile();
    if (isObjectXmlFile(localPath)) {
        await compareCurrentObjectWithAccount(progress, token);
    } else {
        await compareScriptWithAccount(progress, token, compile);
    }
}

export async function uploadCurrentFile(progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken, confirm: boolean = false) {
    await ensureActiveFileSaved();
    const localPath = getPathForCurrentFile();
    if (isObjectXmlFile(localPath)) {
        await uploadCurrentObject(progress, token, confirm);
    } else {
        await uploadScriptFile(progress, token, confirm);
    }
}

export async function compareAndUploadCurrentFile(progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) {
    await ensureActiveFileSaved();
    const localPath = getPathForCurrentFile();
    if (isObjectXmlFile(localPath)) {
        await uploadCurrentObject(progress, token, true);
    } else {
        await uploadScriptFile(progress, token, true);
    }
}