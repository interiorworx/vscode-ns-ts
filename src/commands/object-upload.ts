import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getOutputChannel, SuiteCloudError, importObjectIn, deployProjectIn, addProjectDependenciesIn } from '../suitecloud';
import { createTempSdfProject, getPathForCurrentFile, isObjectXmlFile, deriveObjectInfoFromPath, copyObjectXmlToProject, writeDeployXmlForObject, createTempProjectContext, compareAndConfirmIfNeeded, findMatchingXml, openDiff } from '../utils';

export async function compareCurrentObjectWithAccount(progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) {
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

export async function uploadCurrentObject(progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken, confirm: boolean = false) {
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