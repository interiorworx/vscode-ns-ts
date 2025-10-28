import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getOutputChannel, getRemotePathForLocal, importFilesIn, SuiteCloudError, findSdfRoot } from './suitecloud';
import * as os from 'os';
import { spawn } from 'child_process';

export function getPathForCurrentFile(): string {
    const active = vscode.window.activeTextEditor;
    if (!active) {
      throw new Error('No active editor. Open a file to compare.');
    }

    const localUri = active.document.uri;
    if (localUri.scheme !== 'file') {
      throw new Error('Only local files are supported.');
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(localUri);
    if (!workspaceFolder) {
      throw new Error('Open a workspace containing your SuiteCloud project.');
    }

    return localUri.fsPath;
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

export function createTempSdfProject(baseTempDir: string): string {
  const out = getOutputChannel();
  const root = findSdfRoot();
  const tmpProjectDir = path.join(baseTempDir, 'sdf-temp');

  if (!fs.existsSync(tmpProjectDir)) fs.mkdirSync(tmpProjectDir, { recursive: true });
  const destManifest = path.join(tmpProjectDir, 'manifest.xml');
  
  const manifestPath = path.join(root, 'manifest.xml');
  fs.copyFileSync(manifestPath, destManifest);
  out.appendLine(`[temp] Copied manifest to ${destManifest}`);
  
  const projectJson = path.join(root, 'project.json');
  fs.copyFileSync(projectJson, path.join(tmpProjectDir, 'project.json'));
  out.appendLine(`[temp] Copied project.json to ${path.join(tmpProjectDir, 'project.json')}`);

  const fileCabinetDir = path.join(tmpProjectDir, 'FileCabinet');
  if (!fs.existsSync(fileCabinetDir)) fs.mkdirSync(fileCabinetDir);

  const suiteScriptsDir = path.join(fileCabinetDir, 'SuiteScripts');
  if (!fs.existsSync(suiteScriptsDir)) fs.mkdirSync(suiteScriptsDir);

  return tmpProjectDir;
}

export async function transpileLocalTsToJs(localTsPath: string): Promise<string> {
  const out = getOutputChannel();
  if (!fs.existsSync(localTsPath)) {
    throw new SuiteCloudError(`Local file not found: ${localTsPath}`);
  }
  if (!/\.(ts|tsx)$/i.test(localTsPath)) {
    throw new SuiteCloudError('transpileLocalTsToJs expects a .ts or .tsx file');
  }
  const fileDir = path.dirname(localTsPath);
  const jsFilePath = localTsPath.replace(/\.(ts|tsx)$/i, '.js');

  // Determine tsc path (prefer local project binary)
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(localTsPath));
  if (!workspaceFolder) {
    throw new SuiteCloudError('Open a workspace containing your TypeScript project.');
  }
  const projectDir = workspaceFolder.uri.fsPath;
  const tscLocalUnix = path.join(projectDir, 'node_modules', '.bin', 'tsc');
  const tscLocalWin = path.join(projectDir, 'node_modules', '.bin', 'tsc.cmd');
  const tscCmd = fs.existsSync(tscLocalUnix)
    ? tscLocalUnix
    : fs.existsSync(tscLocalWin)
      ? tscLocalWin
      : 'tsc';

  const args = [ '-p', projectDir ];

  out.appendLine(`[transpile] Running: ${tscCmd} ${args.join(' ')}`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(tscCmd, args, { cwd: projectDir });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => reject(new SuiteCloudError(`Failed to start tsc: ${err.message}`)));
    child.on('close', (code) => {
      if (stdout.trim()) out.appendLine(`[tsc][stdout]\n${stdout}`);
      if (stderr.trim()) out.appendLine(`[tsc][stderr]\n${stderr}`);
    //   if (code !== 0) return reject(new SuiteCloudError(`tsc exited with code ${code}`));
      resolve();
    });
  });

  if (!fs.existsSync(jsFilePath)) {
    throw new SuiteCloudError('TypeScript compile did not emit JavaScript next to the source file.');
  }
  out.appendLine(`[transpile] ${path.basename(localTsPath)} -> ${path.basename(jsFilePath)}`);
  return jsFilePath;
}