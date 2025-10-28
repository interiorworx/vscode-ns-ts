import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createTempSdfProject, downloadRemoteToTemp, getPathForCurrentFile, transpileLocalTsToJs, isObjectXmlFile, deriveObjectInfoFromPath, copyObjectXmlToProject, writeDeployXmlForObject } from './utils';
import { getOutputChannel, listAuthAccounts, readProjectDefaultAuthId, setProjectDefaultAuthId, isProduction, getRemotePathForLocal, uploadFiles, SuiteCloudError, importObjectIn, deployProjectIn, addProjectDependenciesIn } from './suitecloud';

export async function changeAccount(progress: vscode.Progress<{ message?: string }>, _token: vscode.CancellationToken) {
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

export async function compareCurrentFileWithAccount(progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken, compile: boolean = true) {
    await ensureActiveFileSaved();
    const localPath = getPathForCurrentFile();
    if (isObjectXmlFile(localPath)) {
        await compareCurrentObjectWithAccount(progress, token);
    } else {
        await compareScriptWithAccount(progress, token, compile);
    }
}

export async function uploadCurrentFile(progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken, confirm: boolean = false) {
    await ensureActiveFileSaved();
    const localPath = getPathForCurrentFile();
    if (isObjectXmlFile(localPath)) {
        await uploadCurrentObject(progress, token, confirm);
    } else {
        await uploadScriptFile(progress, token, confirm);
    }
}

export async function compareAndUploadCurrentFile(progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) {
    await ensureActiveFileSaved();
    const localPath = getPathForCurrentFile();
    if (isObjectXmlFile(localPath)) {
        await uploadCurrentObject(progress, token, true);
    } else {
        await uploadScriptFile(progress, token, true);
    }
}

async function compareScriptWithAccount(progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken, compile: boolean = true) {
    const out = getOutputChannel();
    const { tmpDir, tmpProjectDir } = createTempProjectContext(out, progress, 'compare');

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
        }, token);

        await openDiff(downloadedJsPath, localJsPath, `Account ⟷ Local (JS): ${path.basename(localJsPath)}`);
    } else {
        progress.report({ message: 'Importing file from account...' });
        const downloadedPath = await downloadRemoteToTemp(localPath, tmpProjectDir, tmpDir, undefined, token);
        await openDiff(downloadedPath, localPath, `Account ⟷ Local: ${path.basename(localPath)}`);
    }
}


async function uploadScriptFile(progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken, confirm: boolean = false) {
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

    // Step 1: compile TS (always run tsc for TS files so JS is fresh)
    if (isTs) {
        progress.report({ message: 'Compiling TypeScript...' });
        await transpileLocalTsToJs(localPath);
    }

    const toUpload: string[] = [];
    if (isTs) toUpload.push(remoteTsPath);
    toUpload.push(isTs ? remoteJs : remoteTsPath);
    const confirmed = await compareAndConfirmIfNeeded(confirm, async () => {
        await compareCurrentFileWithAccount(progress, token, false);
    }, toUpload, async () => {
        await closeCompareDiffTabsFor(localPath);
    });
    if (!confirmed) return;

    // Step 4: upload ts/js
    const remotePaths: string[] = [];
    if (isTs) remotePaths.push(remoteTsPath);
    const jsRemote = isTs ? remoteJs : remoteTsPath;
    if (/\.(js)$/i.test(jsRemote)) remotePaths.push(jsRemote);

    progress.report({ message: `Uploading ${remotePaths.length} file(s) to account...` });
    out.appendLine(`[upload] Paths: ${remotePaths.join(', ')}`);
    await uploadFiles(remotePaths, token);
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

export async function compareCurrentObjectWithAccount(progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) {
    const out = getOutputChannel();
    const localPath = getPathForCurrentFile();
    if (!isObjectXmlFile(localPath)) {
        vscode.window.showErrorMessage('This command only supports object XML files under the Objects directory.');
        return;
    }
    const { tmpDir, tmpProjectDir } = createTempProjectContext(out, progress, 'obj-compare');

    const { type, scriptId } = deriveObjectInfoFromPath(localPath);
    const destFolder = '/Objects/Compare';

    // Ensure destination folder exists in temp project
    const compareFolderPath = path.join(tmpProjectDir, 'Objects', 'Compare');
    if (!fs.existsSync(compareFolderPath)) fs.mkdirSync(compareFolderPath, { recursive: true });

    progress.report({ message: 'Importing object from account...' });
    await importObjectIn(tmpProjectDir, { type, scriptIds: [scriptId], destinationFolder: destFolder, excludeFiles: true }, token);

    // Find the imported xml under the destination folder
    const importedBase = path.join(tmpProjectDir, destFolder.replace(/^\//, ''));
    const downloadedPath = findMatchingXml(importedBase, scriptId);
    if (!downloadedPath) {
        throw new SuiteCloudError(`Downloaded object was not found under ${importedBase}`);
    }

    await openDiff(downloadedPath, localPath, `Account ⟷ Local (Object): ${path.basename(localPath)}`);
}

export async function uploadCurrentObject(progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken, confirm: boolean = false) {
    const out = getOutputChannel();
    const localPath = getPathForCurrentFile();
    if (!isObjectXmlFile(localPath)) {
        vscode.window.showErrorMessage('This command only supports object XML files under the Objects directory.');
        return;
    }

    const relative = deriveObjectInfoFromPath(localPath).relativePath;
    const confirmed = await compareAndConfirmIfNeeded(confirm, async () => {
        await compareCurrentObjectWithAccount(progress, token);
    }, [relative]);
    if (!confirmed) return;

    progress.report({ message: 'Creating deployment project...' });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-obj-upload-'));
    out.appendLine(`[obj-upload] Temp dir: ${tmpDir}`);
    const tmpProjectDir = await createTempSdfProject(tmpDir);
    out.appendLine(`[obj-upload] Temp project: ${tmpProjectDir}`);

    const objectRelPath = copyObjectXmlToProject(tmpProjectDir, localPath);
    writeDeployXmlForObject(tmpProjectDir, objectRelPath);

    progress.report({ message: 'Adding dependencies to manifest...' });
    await addProjectDependenciesIn(tmpProjectDir, token);

    progress.report({ message: 'Deploying object to account...' });
    await deployProjectIn(tmpProjectDir, undefined, token);
    vscode.window.showInformationMessage('Object upload complete.');
}

export async function compareAndUploadCurrentObject(progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) {
    await uploadCurrentObject(progress, token, true);
}

function findMatchingXml(baseDir: string, scriptId: string): string | undefined {
    const stack: string[] = [baseDir];
    const lowerScriptId = scriptId.toLowerCase();
    const candidates: string[] = [];
    while (stack.length) {
        const dir = stack.pop()!;
        if (!fs.existsSync(dir)) continue;
        for (const entry of fs.readdirSync(dir)) {
            const p = path.join(dir, entry);
            const stat = fs.statSync(p);
            if (stat.isDirectory()) {
                stack.push(p);
            } else if (stat.isFile() && /\.xml$/i.test(entry)) {
                candidates.push(p);
            }
        }
    }
    // Prefer filename containing scriptid
    const preferred = candidates.find(c => path.basename(c).toLowerCase().includes(lowerScriptId));
    return preferred || candidates[0];
}

function createTempProjectContext(out: vscode.OutputChannel, progress: vscode.Progress<{ message?: string }>, prefix: string): { tmpDir: string; tmpProjectDir: string } {
    progress.report({ message: 'Creating temporary project...' });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
    out.appendLine(`[${prefix}] Temp dir: ${tmpDir}`);
    const tmpProjectDir = createTempSdfProject(tmpDir);
    out.appendLine(`[${prefix}] Temp project: ${tmpProjectDir}`);
    return { tmpDir, tmpProjectDir };
}

async function openDiff(leftPath: string, rightPath: string, title: string): Promise<void> {
    const left = vscode.Uri.file(leftPath).with({ scheme: 'file' });
    const right = vscode.Uri.file(rightPath).with({ scheme: 'file' });
    await vscode.commands.executeCommand('vscode.diff', left, right, title);
}

function getProtectionContext(): { current?: string; isProdAccount: boolean; protectionEnabled: boolean; targetLabel: string } {
    const protectionSetting = vscode.workspace.getConfiguration('vscode-ns-ts').get<boolean>('productionUploadProtection', true);
    const current = readProjectDefaultAuthId();
    const isProdAccount = current ? isProduction(current) : true;
    const protectionEnabled = !!protectionSetting && isProdAccount;
    const targetLabel = current ? (isProdAccount ? `${current} (PRODUCTION)` : `${current} (sandbox)`) : 'unknown account';
    return { current, isProdAccount, protectionEnabled, targetLabel };
}

async function compareAndConfirmIfNeeded(
    forceConfirm: boolean,
    compareAction: () => Promise<void>,
    files: string[],
    onCancel?: () => Promise<void>
): Promise<boolean> {
    const { isProdAccount, protectionEnabled, targetLabel } = getProtectionContext();
    if (protectionEnabled || forceConfirm) {
        try {
            await compareAction();
        } catch (error) {
            getOutputChannel().appendLine(`[confirm] Compare failed: ${error}`);
            vscode.window.showErrorMessage((error as SuiteCloudError).message);
        }
        const confirmed = await showPersistentUploadConfirm(targetLabel, files, isProdAccount);
        if (!confirmed) {
            if (onCancel) await onCancel();
            return false;
        }
    }
    return true;
}

async function ensureActiveFileSaved(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    if (!doc.isDirty) return;
    const ok = await doc.save();
    if (!ok) {
        throw new SuiteCloudError('Please save the current file before running this command.');
    }
}