import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createTempSdfProject, downloadRemoteToTemp, getPathForCurrentFile, transpileLocalTsToJs, isObjectXmlFile, deriveObjectInfoFromPath, copyObjectXmlToProject, writeDeployXmlForObject } from './utils';
import { getOutputChannel, listAuthAccounts, readProjectDefaultAuthId, setProjectDefaultAuthId, isProduction, getRemotePathForLocal, uploadFiles, SuiteCloudError, importObjectIn, deployProjectIn, addProjectDependenciesIn, listFileCabinetPaths, importFiles, importFolder, getLocalPathForRemote } from './suitecloud';

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

function countOverwrites(remotePaths: string[]): number {
    return remotePaths.filter(r => fs.existsSync(getLocalPathForRemote(r))).length;
}

async function confirmOverwriteIfAny(targetLabel: string, remotePaths: string[]): Promise<boolean> {
    const n = countOverwrites(remotePaths);
    if (n === 0) return true;
    const choice = await vscode.window.showWarningMessage(
        `Importing ${targetLabel} will overwrite ${n} local file(s). Continue?`,
        { modal: true },
        'Yes', 'No'
    );
    return choice === 'Yes';
}

export async function importFromAccount(progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) {
    const out = getOutputChannel();
    const rootFolder = '/SuiteScripts';
    progress.report({ message: 'Listing File Cabinet...' });
    const allFiles = await listFileCabinetPaths(rootFolder);
    out.appendLine(`[import] Total files listed: ${allFiles.length}`);

    type Item = vscode.QuickPickItem & { itemType: 'file' | 'folder' | 'action'; path?: string };
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = 'Import From Account';
    qp.placeholder = 'Type to search across all files, or browse folders';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.ignoreFocusOut = true;

    let currentFolder = rootFolder;
    let inSearch = false;

    // Precompute all folders from the file list (includes root and all ancestors)
    const folderSet = new Set<string>();
    folderSet.add(rootFolder);
    for (const filePath of allFiles) {
        let dir = filePath.replace(/\/[^\/]+$/, '');
        while (dir.startsWith(rootFolder)) {
            folderSet.add(dir);
            const parent = dir.replace(/\/[^\/]+$/, '');
            if (parent === dir || parent.length < rootFolder.length) break;
            dir = parent;
        }
    }
    const allFolders = Array.from(folderSet);

    const refreshBrowse = () => {
        inSearch = false;
        qp.value = '';
        const items: Item[] = [];
        if (currentFolder !== rootFolder) {
            const parent = currentFolder.replace(/\/$/, '');
            const up = parent.substring(0, parent.lastIndexOf('/')) || '/';
            const upAdjusted = up.length < rootFolder.length ? rootFolder : up; // do not go above rootFolder
            items.push({ label: '$(arrow-left) ..', description: upAdjusted, itemType: 'folder', path: upAdjusted });
            items.push({ label: '$(cloud-download) Import this folder', description: currentFolder, itemType: 'action', path: currentFolder });
        } else {
            // At root, still allow importing the entire root folder
            items.push({ label: '$(cloud-download) Import this folder', description: currentFolder, itemType: 'action', path: currentFolder });
        }

        const rels = allFiles
            .filter(p => p.startsWith(currentFolder.replace(/\/$/, '') + '/'))
            .map(p => p.slice(currentFolder.replace(/\/$/, '').length + 1));
        const folderSet = new Set<string>();
        const fileSet = new Set<string>();
        for (const rel of rels) {
            const slash = rel.indexOf('/');
            if (slash === -1) {
                fileSet.add(rel);
            } else {
                folderSet.add(rel.substring(0, slash));
            }
        }
        const folders = Array.from(folderSet).sort();
        const files = Array.from(fileSet).sort();
        for (const f of folders) {
            const p = currentFolder.replace(/\/$/, '') + '/' + f;
            // Show only parent (currentFolder) in the gray description, not the folder name itself
            items.push({ label: `$(folder) ${f}/`, description: currentFolder, itemType: 'folder', path: p });
        }
        for (const f of files) {
            const p = currentFolder.replace(/\/$/, '') + '/' + f;
            // Show only parent (currentFolder) in the gray description, not the file name itself
            items.push({ label: `$(file) ${f}`, description: currentFolder, itemType: 'file', path: p });
        }
        qp.items = items;
    };

    const refreshSearch = (query: string) => {
        inSearch = true;
        const q = query.toLowerCase();
        const matchedFolders = allFolders.filter(p => p.toLowerCase().includes(q));
        const matchedFiles = allFiles.filter(p => p.toLowerCase().includes(q));
        const items: Item[] = [];

        // Folders first
        for (const p of matchedFolders) {
            const lastSlash = p.lastIndexOf('/');
            const parentPath = lastSlash > 0 ? p.substring(0, lastSlash) : '/';
            const base = p.substring(lastSlash + 1) || p; // base name
            items.push({
                label: `$(folder) ${base}/`,
                description: parentPath,
                itemType: 'folder',
                path: p,
            } as Item);
            if (items.length >= 200) break;
        }
        // Then files
        for (const p of matchedFiles) {
            const lastSlash = p.lastIndexOf('/')
            const parentPath = lastSlash > 0 ? p.substring(0, lastSlash) : '/';
            items.push({
                label: `$(file) ${p.substring(p.lastIndexOf('/') + 1)}`,
                description: parentPath,
                itemType: 'file',
                path: p,
            } as Item);
            if (items.length >= 200) break;
        }
        qp.items = items.length ? items : [{ label: 'No results', itemType: 'action' } as Item];
    };

    qp.onDidChangeValue((val) => {
        if (val && val.trim().length > 0) {
            refreshSearch(val.trim());
        } else {
            refreshBrowse();
        }
    });

    qp.onDidAccept(async () => {
        const picked = qp.selectedItems[0] as Item | undefined;
        if (!picked) return;
        if (picked.itemType === 'folder' && picked.path) {
            currentFolder = picked.path;
            refreshBrowse();
            return;
        }
        if (picked.itemType === 'action' && picked.path && picked.label.includes('Import this folder')) {
            qp.busy = true;
            try {
                const folder = picked.path;
                const folderPrefix = folder.replace(/\/$/, '') + '/';
                const remotePaths = allFiles
                    .filter(p => p.startsWith(folderPrefix))
                    .filter(p => /\/[^/]+\.[^/]+$/i.test(p));
                const proceed = await confirmOverwriteIfAny(`folder ${folder}`, remotePaths);
                if (!proceed) { qp.busy = false; return; }

                progress.report({ message: `Importing folder ${folder}...` });
                await importFolder(folder, { excludeProperties: true }, token);
                vscode.window.showInformationMessage(`Imported folder: ${folder}`);
                qp.hide();
            } catch (e: any) {
                vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
            } finally {
                qp.busy = false;
            }
            return;
        }
        if (picked.itemType === 'file' && picked.path) {
            qp.busy = true;
            try {
                const remote = picked.path;
                const proceed = await confirmOverwriteIfAny(remote, [remote]);
                if (!proceed) { qp.busy = false; return; }

                progress.report({ message: `Importing ${remote}...` });
                await importFiles([remote], { excludeProperties: true }, token);
                vscode.window.showInformationMessage(`Imported: ${remote}`);
                qp.hide();
            } catch (e: any) {
                vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
            } finally {
                qp.busy = false;
            }
        }
    });

    qp.onDidHide(() => qp.dispose());
    refreshBrowse();
    qp.show();
}