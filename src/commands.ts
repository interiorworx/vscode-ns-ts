import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createTempSdfProject, downloadRemoteToTemp, getPathForCurrentFile, transpileLocalTsToJs } from './utils';
import { getOutputChannel, listAuthAccounts, readProjectDefaultAuthId, setProjectDefaultAuthId, isProduction, getRemotePathForLocal, uploadFiles, SuiteCloudError } from './suitecloud';

export async function compareCurrentFileWithAccount(progress: vscode.Progress<{ message?: string }>, compile: boolean = true) {
    const out = getOutputChannel();
    progress.report({ message: 'Creating temporary project...' });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-compare-'));
    out.appendLine(`[compare] Temp dir: ${tmpDir}`);

    const tmpProjectDir = await createTempSdfProject(tmpDir);
    out.appendLine(`[compare] Temp project: ${tmpProjectDir}`);

    const localPath = getPathForCurrentFile();
    const compareAsJs = vscode.workspace.getConfiguration('vscode-ns-ts').get<boolean>('compareAsJs', true);
    const isTs = /\.(ts)$/i.test(localPath);

    if (compareAsJs && isTs) {
        progress.report({ message: 'Compiling TypeScript...' });
        const localJsPath = localPath.replace(/\.(ts)$/i, '.js');
        if (compile) {
            await transpileLocalTsToJs(localPath);
        }

        const remoteJsPath = getRemotePathForLocal(localPath).replace(/\.(ts)$/i, '.js');
        progress.report({ message: 'Importing JavaScript from account...' });
        const downloadedJsPath = await downloadRemoteToTemp(localPath, tmpProjectDir, tmpDir, {
            remoteOverridePath: remoteJsPath,
            destBaseName: path.basename(localJsPath),
        });

        progress.report({ message: 'Opening JS diff...' });
        const left = vscode.Uri.file(downloadedJsPath).with({ scheme: 'file' });
        const right = vscode.Uri.file(localJsPath).with({ scheme: 'file' });
        const title = `Account ⟷ Local (JS): ${path.basename(localJsPath)}`;
        await vscode.commands.executeCommand('vscode.diff', left, right, title);
    } else {
        progress.report({ message: 'Importing file from account...' });
        const downloadedPath = await downloadRemoteToTemp(localPath, tmpProjectDir, tmpDir);

        progress.report({ message: 'Opening diff...' });
        const left = vscode.Uri.file(downloadedPath).with({ scheme: 'file' });
        const right = vscode.Uri.file(localPath).with({ scheme: 'file' });
        const title = `Account ⟷ Local: ${path.basename(localPath)}`;
        await vscode.commands.executeCommand('vscode.diff', left, right, title);
    }
}

export async function changeAccount(progress: vscode.Progress<{ message?: string }>) {
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

export async function uploadCurrentFile(progress: vscode.Progress<{ message?: string }>, confirm: boolean = false) {
    const out = getOutputChannel();
    const localPath = getPathForCurrentFile();
    const isTs = /\.(ts)$/i.test(localPath);
    const isJs = /\.(js)$/i.test(localPath);
    if (!isTs && !isJs) {
        vscode.window.showErrorMessage('Only .ts or .js files under SuiteScripts can be uploaded.');
        return;
    }

    const remoteTsPath = getRemotePathForLocal(localPath);
    const remoteJs = getRemotePathForLocal(localPath).replace(/\.(ts)$/i, '.js');

    const protectionSetting = vscode.workspace.getConfiguration('vscode-ns-ts').get<boolean>('productionUploadProtection', true);
    const current = readProjectDefaultAuthId();
    const isProdAccount = current ? isProduction(current) : true;
    const protectionEnabled = !!protectionSetting && isProdAccount;

    // Step 1: compile TS (always run tsc for TS files so JS is fresh)
    if (isTs) {
        progress.report({ message: 'Compiling TypeScript...' });
        await transpileLocalTsToJs(localPath);
    }

    if (protectionEnabled || confirm) {
        // Step 2: compare js/ts (open a diff to review)
        try {
            await compareCurrentFileWithAccount(progress, false);
        } catch (error) {
            out.appendLine(`[upload] Error comparing file with account: ${error}`);
            vscode.window.showErrorMessage((error as SuiteCloudError).message);
        }

        // Step 3: show confirmation (show account and files to be uploaded)
        const targetLabel = current ? (isProdAccount ? `${current} (PRODUCTION)` : `${current} (sandbox)`) : 'unknown account';
        const toUpload: string[] = [];
        if (isTs) toUpload.push(remoteTsPath);
        toUpload.push(isTs ? remoteJs : remoteTsPath);

        out.appendLine(`[upload] Confirm upload to ${targetLabel} with files:`);
        out.appendLine(toUpload.map(p => `${path.basename(p)}`).join(', '));
        const confirmed = await showPersistentUploadConfirm(targetLabel, toUpload, isProdAccount);
        if (!confirmed) {
            await closeCompareDiffTabsFor(localPath);
            return;
        }
    }

    // Step 4: upload ts/js
    const remotePaths: string[] = [];
    if (isTs) remotePaths.push(remoteTsPath);
    const jsRemote = isTs ? remoteJs : remoteTsPath;
    if (/\.(js)$/i.test(jsRemote)) remotePaths.push(jsRemote);

    progress.report({ message: `Uploading ${remotePaths.length} file(s) to account...` });
    out.appendLine(`[upload] Paths: ${remotePaths.join(', ')}`);
    await uploadFiles(remotePaths);
    vscode.window.showInformationMessage('Upload complete.');
    await closeCompareDiffTabsFor(localPath);
}

async function showPersistentUploadConfirm(targetLabel: string, files: string[], isProd: boolean): Promise<boolean> {
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem>();
    qp.title = `Upload to ${targetLabel}`;
    qp.placeholder = 'Select an action';
    qp.matchOnDetail = true;
    qp.ignoreFocusOut = true;
    const uploadLabel = isProd ? '$(warning) Upload to PRODUCTION' : '$(cloud-upload) Upload';
    qp.items = [
        { label: uploadLabel, detail: files.map(f => `${path.basename(f)}`).join(', ') },
        { label: '$(x) Cancel', detail: 'Do not upload' }
    ];

    return new Promise<boolean>((resolve) => {
        qp.onDidAccept(() => {
            const picked = qp.selectedItems[0];
            qp.hide();
            resolve(!!picked && picked.label.includes('Upload'));
        });
        qp.onDidHide(() => {
            qp.dispose();
            resolve(false);
        });
        qp.show();
    });
}

async function closeCompareDiffTabsFor(localPath: string): Promise<void> {
    try {
        const names: string[] = [path.basename(localPath)];
        if (/\.(ts)$/i.test(localPath)) {
            names.push(path.basename(localPath).replace(/\.(ts)$/i, '.js'));
        }
        const labelMatchers = [
            (label: string) => /Account\s*[⟷<\->]+\s*Local/i.test(label),
        ];
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                const label = tab.label || '';
                const looksLikeCompare = labelMatchers.some(m => m(label));
                if (!looksLikeCompare) continue;
                if (names.some(n => label.includes(n))) {
                    await vscode.window.tabGroups.close(tab);
                }
            }
        }
    } catch {}
}

export async function compareAndUploadCurrentFile(progress: vscode.Progress<{ message?: string }>) {
    await uploadCurrentFile(progress, true);
}