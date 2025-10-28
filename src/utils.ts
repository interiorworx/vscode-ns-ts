import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getOutputChannel, SuiteCloudError, findSdfRoot, readProjectDefaultAuthId, isProduction } from './suitecloud';
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

  const objectsDir = path.join(tmpProjectDir, 'Objects');
  if (!fs.existsSync(objectsDir)) fs.mkdirSync(objectsDir);

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

export function isObjectXmlFile(localPath: string): boolean {
  try {
    const root = findSdfRoot();
    const objectsDir = path.join(root, 'Objects');
    if (!fs.existsSync(objectsDir) || !fs.statSync(objectsDir).isDirectory()) return false;
    if (!localPath.toLowerCase().endsWith('.xml')) return false;
    return localPath.startsWith(objectsDir + path.sep) || localPath === objectsDir;
  } catch {
    return false;
  }
}

export function extractScriptIdFromXml(xmlFilePath: string): string {
  const data = fs.readFileSync(xmlFilePath, 'utf8');
  // common case: scriptid attribute on the root element
  const attrMatch = data.match(/\sscriptid\s*=\s*"([^"]+)"/i);
  if (attrMatch && attrMatch[1]) return attrMatch[1];
  // fallback: <scriptid>value</scriptid>
  const elemMatch = data.match(/<\s*scriptid\s*>\s*([^<\s]+)\s*<\s*\/\s*scriptid\s*>/i);
  if (elemMatch && elemMatch[1]) return elemMatch[1];
  throw new SuiteCloudError(`Could not determine scriptid from: ${path.basename(xmlFilePath)}`);
}

export function extractSdfTypeFromXml(xmlFilePath: string): string {
  const data = fs.readFileSync(xmlFilePath, 'utf8');
  // remove XML declaration and leading comments/whitespace
  const cleaned = data.replace(/<\?xml[\s\S]*?\?>/i, '').replace(/<!--([\s\S]*?)-->/g, '').trim();
  const rootMatch = cleaned.match(/<\s*([A-Za-z0-9_:-]+)\b/);
  if (!rootMatch) throw new SuiteCloudError(`Could not determine object type from: ${path.basename(xmlFilePath)}`);
  const qname = rootMatch[1];
  const localName = qname.includes(':') ? qname.split(':')[1] : qname;
  return localName.toLowerCase();
}

export function deriveObjectInfoFromPath(localObjectXmlPath: string): { type: string; scriptId: string; relativePath: string } {
  const root = findSdfRoot();
  const objectsDir = path.join(root, 'Objects');
  if (!localObjectXmlPath.startsWith(objectsDir)) {
    throw new SuiteCloudError('Object XML must be under the project Objects directory.');
  }
  const relativeFromObjects = path.relative(objectsDir, localObjectXmlPath);
  const type = extractSdfTypeFromXml(localObjectXmlPath);
  const scriptId = extractScriptIdFromXml(localObjectXmlPath);
  const relativePath = path.join('Objects', relativeFromObjects);
  return { type, scriptId, relativePath };
}

export function copyObjectXmlToProject(tempProjectDir: string, localObjectXmlPath: string): string {
  const { relativePath } = deriveObjectInfoFromPath(localObjectXmlPath);
  const destPath = path.join(tempProjectDir, relativePath);
  const destDir = path.dirname(destPath);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(localObjectXmlPath, destPath);
  return relativePath; // returned as project-relative path (starts with Objects)
}

export function writeDeployXmlForObject(projectDir: string, objectRelativePath: string): string {
  const deployXmlPath = path.join(projectDir, 'deploy.xml');
  const normalized = objectRelativePath.replace(/\\/g, '/').replace(/^\/?/, '');
  const deployPath = `~/${normalized}`;
  const xml = [
    '<deploy>',
    '  <objects>',
    `    <path>${deployPath}</path>`,
    '  </objects>',
    '</deploy>',
    ''
  ].join('\n');
  fs.writeFileSync(deployXmlPath, xml, 'utf8');
  return deployXmlPath;
}

export async function showPersistentUploadConfirm(targetLabel: string, files: string[], isProd: boolean): Promise<boolean> {
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

export async function closeCompareDiffTabsFor(localPath: string): Promise<void> {
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
    } catch { }
}


export function findMatchingXml(baseDir: string, scriptId: string): string | undefined {
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
    const preferred = candidates.find(c => path.basename(c).toLowerCase().includes(lowerScriptId));
    return preferred || candidates[0];
}

export function createTempProjectContext(out: vscode.OutputChannel, progress: vscode.Progress<{ message?: string }>, prefix: string): { tmpDir: string; tmpProjectDir: string } {
    progress.report({ message: 'Creating temporary project...' });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
    out.appendLine(`[${prefix}] Temp dir: ${tmpDir}`);
    const tmpProjectDir = createTempSdfProject(tmpDir);
    out.appendLine(`[${prefix}] Temp project: ${tmpProjectDir}`);
    return { tmpDir, tmpProjectDir };
}

export async function openDiff(leftPath: string, rightPath: string, title: string): Promise<void> {
    const left = vscode.Uri.file(leftPath).with({ scheme: 'file' });
    const right = vscode.Uri.file(rightPath).with({ scheme: 'file' });
    await vscode.commands.executeCommand('vscode.diff', left, right, title);
}

export function getProtectionContext(): { current?: string; isProdAccount: boolean; protectionEnabled: boolean; targetLabel: string } {
    const protectionSetting = vscode.workspace.getConfiguration('vscode-ns-ts').get<boolean>('productionUploadProtection', true);
    const current = readProjectDefaultAuthId();
    const isProdAccount = current ? isProduction(current) : true;
    const protectionEnabled = !!protectionSetting && isProdAccount;
    const targetLabel = current ? (isProdAccount ? `${current} (PRODUCTION)` : `${current} (sandbox)`) : 'unknown account';
    return { current, isProdAccount, protectionEnabled, targetLabel };
}

export async function compareAndConfirmIfNeeded(
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

export async function ensureActiveFileSaved(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    if (!doc.isDirty) return;
    const ok = await doc.save();
    if (!ok) {
        throw new SuiteCloudError('Please save the current file before running this command.');
    }
}
