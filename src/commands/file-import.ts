import * as vscode from 'vscode';
import * as fs from 'fs';
import { getOutputChannel, listFileCabinetPaths, importFiles, importFolder } from '../suitecloud';
import { getLocalPathForRemote } from './file-upload';

export async function importFromAccount(progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) {
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
        }

        items.push({ label: '$(cloud-download) Import this folder', description: currentFolder, itemType: 'action', path: currentFolder });

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
        const base = currentFolder.replace(/\/$/, '');
        const foldersInScope = allFolders.filter(p => p === base || p.startsWith(base + '/'));
        const filesInScope = allFiles.filter(p => p.startsWith(base + '/'));
        const matchedFolders = foldersInScope.filter(p => p.toLowerCase().includes(q));
        const matchedFiles = filesInScope.filter(p => p.toLowerCase().includes(q));
        const items: Item[] = [];

        // Folders first
        for (const p of matchedFolders) {
            const lastSlash = p.lastIndexOf('/');
            const parentPath = lastSlash > 0 ? p.substring(0, lastSlash) : '/';
            const baseName = p.substring(lastSlash + 1) || p; // base name
            items.push({
                label: `$(folder) ${baseName}/`,
                description: parentPath,
                itemType: 'folder',
                path: p,
            } as Item);
            if (items.length >= 200) break;
        }
        // Then files
        for (const p of matchedFiles) {
            const lastSlash = p.lastIndexOf('/');
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