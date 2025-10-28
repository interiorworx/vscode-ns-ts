import * as vscode from 'vscode';
import * as path from 'path';
import { compareCurrentFileWithAccount } from '.';
import { findSdfRoot, getOutputChannel, importFilesIn, SuiteCloudError, uploadFiles } from '../suitecloud';
import { createTempProjectContext, getPathForCurrentFile, transpileLocalTsToJs, openDiff, compareAndConfirmIfNeeded, closeCompareDiffTabsFor } from '../utils';
import { log } from 'console';
import * as fs from 'fs';

export async function compareScriptWithAccount(progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken, compile: boolean = true) {
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

export async function uploadScriptFile(progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken, confirm: boolean = false) {
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

export function getLocalPathForRemote(remotePath: string): string {
  const root = findSdfRoot();
  const normalized = remotePath.replace(/^\/+/, '');
  return path.join(root, 'FileCabinet', normalized);
}

export function getRemotePathForLocal(localFilePath: string): string {
    const root = findSdfRoot();

    const suiteScriptsDir = path.join(root, 'FileCabinet', 'SuiteScripts');
    log(`[mapping] SuiteScripts dir: ${suiteScriptsDir}`);
    if (!fs.existsSync(suiteScriptsDir) || !fs.statSync(suiteScriptsDir).isDirectory()) {
        throw new SuiteCloudError('SuiteScripts folder not found at project root.');
    }
    
    if (!localFilePath.startsWith(suiteScriptsDir)) {
        throw new SuiteCloudError('This command only supports files inside the SuiteScripts folder at the project root.');
    }

    const relative = path.relative(suiteScriptsDir, localFilePath);
    const remote = `/SuiteScripts/${relative.split(path.sep).join('/')}`;
    log(`[mapping] Local -> Remote: ${localFilePath} -> ${remote}`);
    return remote;
}

export async function downloadRemoteToTemp(localFilePath: string, tempProjectDir: string, destFolder: string, options?: { remoteOverridePath?: string; destBaseName?: string }, token?: vscode.CancellationToken): Promise<string> {
  const out = getOutputChannel();
  const remotePath = options?.remoteOverridePath ?? getRemotePathForLocal(localFilePath);
  out.appendLine(`[download] Remote path: ${remotePath}`);
  if (!fs.existsSync(destFolder)) fs.mkdirSync(destFolder, { recursive: true });

  const base = options?.destBaseName ?? path.basename(remotePath);
  const downloadedTempPath = path.join(destFolder, base);

  await importFilesIn(tempProjectDir, [remotePath], { excludeProperties: true }, token);
  const tempFileCandidates = [
    path.join(tempProjectDir, 'FileCabinet', remotePath.replace(/^\//, '')),
    path.join(tempProjectDir, remotePath.replace(/^\//, '')),
  ];
  const source = tempFileCandidates.find(p => fs.existsSync(p));
  if (!source) throw new SuiteCloudError(`File does not exist in the account: ${remotePath}`);
  fs.copyFileSync(source, downloadedTempPath);
  return downloadedTempPath;
}