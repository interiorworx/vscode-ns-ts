import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

export interface SuiteCloudResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class SuiteCloudError extends Error {
  constructor(message: string, public readonly result?: SuiteCloudResult) {
    super(message);
    this.name = 'SuiteCloudError';
  }
}

let outputChannel: vscode.OutputChannel | undefined;
export function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('NetSuite SDF');
  }
  return outputChannel;
}

function log(message: string): void {
  getOutputChannel().appendLine(message);
}

export function findSdfRoot(): string {
  const tryFolder = (folder: vscode.WorkspaceFolder): string | undefined => {
    const dir = path.resolve(folder.uri.fsPath);
    log(`[root] Searching for manifest starting at: ${dir}`);
    const manifestPaths = [
      path.join(dir, 'manifest.xml'),
      path.join(dir, 'src', 'manifest.xml'),
    ];
    for (const manifestPath of manifestPaths) {
      log(`[root] Checking: ${manifestPath}`);
      if (fs.existsSync(manifestPath)) {
        log(`[root] Found manifest in: ${manifestPath}`);
        return path.dirname(manifestPath);
      }
    }
    return undefined;
  };

  const folders = vscode.workspace.workspaceFolders;

  if (!folders || folders.length === 0) {
    log('[root] No workspace folders open');
    throw new SuiteCloudError('Open a workspace containing your SuiteCloud project.');
  }

  // If only one workspace folder, always use that
  if (folders.length === 1) {
    const only = tryFolder(folders[0]);
    if (only) return only;
    log('[root] manifest.xml not found in the only workspace folder');
    throw new SuiteCloudError('Could not locate SuiteCloud project (manifest.xml not found).');
  }

  // Multiple folders: use the one for the current file (or none)
  const activePath = vscode.window.activeTextEditor?.document.fileName;
  if (activePath) {
    const activeFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(activePath));
    if (activeFolder) {
      const fromActive = tryFolder(activeFolder);
      if (fromActive) return fromActive;
      log('[root] Active workspace folder does not contain a SuiteCloud manifest');
      throw new SuiteCloudError('Could not locate SuiteCloud project in the active workspace folder.');
    }
  }

  log('[root] Multiple workspace folders and no active file to select a folder');
  throw new SuiteCloudError('No active file to determine SuiteCloud project in multi-root workspace.');
}

export async function runSuiteCloud(args: string[], token?: vscode.CancellationToken): Promise<SuiteCloudResult> {
  const cwd = findSdfRoot();
  return runSuiteCloudIn(cwd, args, token);
}

// Removed: getProjectRoot, getManifestPath — callers should use findSdfRoot()

export async function runSuiteCloudIn(cwd: string, args: string[], token?: vscode.CancellationToken): Promise<SuiteCloudResult> {
  log(`[suitecloud] (custom cwd) Running: suitecloud ${args.join(' ')} (cwd: ${cwd})`);
  return new Promise((resolve, reject) => {
    const child = spawn('suitecloud', args, {
      cwd,
      shell: false,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let cancelled = false;

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      log(`[suitecloud] (custom cwd) Failed to start: ${err.message}`);
      reject(new SuiteCloudError(`Failed to run suitecloud: ${err.message}`));
    });
    if (token) {
      token.onCancellationRequested(() => {
        cancelled = true;
        log('[suitecloud] Cancellation requested — sending SIGINT to suitecloud process...');
        try { child.kill('SIGINT'); } catch {}
      });
    }
    child.on('close', (code) => {
      log(`[suitecloud] (custom cwd) Exit code: ${code}`);
      if (stdout.trim()) log(`[suitecloud][stdout]\n${stdout}`);
      if (stderr.trim()) log(`[suitecloud][stderr]\n${stderr}`);
      if (cancelled) {
        // Prefer VS Code CancellationError when available
        const anyVscode: any = vscode as any;
        if (anyVscode && anyVscode.CancellationError) {
          return reject(new anyVscode.CancellationError());
        }
        return reject(new SuiteCloudError('Operation cancelled by user', { stdout, stderr, exitCode: code ?? -1 }));
      }
      if (code !== 0) {
        reject(new SuiteCloudError(`suitecloud failed with code ${code}`, { stdout, stderr, exitCode: code ?? -1 }));
      }
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

export async function getSuiteCloudVersion(): Promise<string> {
  const result = await runSuiteCloud(['--version']);
  if (result.exitCode !== 0) {
    throw new SuiteCloudError('suitecloud --version failed', result);
  }
  return result.stdout.trim() || result.stderr.trim();
}

function cleanAnsi(text: string): string {
  const ansiRegex = /\u001b\[[0-?]*[ -\/]*[@-~]/g; // ESC[ ... command
  const bareCsiRegex = /(?:^|\s)\[(?:\d+;?)*[A-Za-z](?=\s|$)/g; // e.g. "[2K" or "[1G"
  return text
    .replace(ansiRegex, '')
    .replace(bareCsiRegex, ' ')
    .replace(/[\r\t]/g, '')
    .trim();
}

export async function listFileCabinetPaths(folder: string = '/'): Promise<string[]> {
  const result = await runSuiteCloud(['file:list', '--folder', folder]);
  const text = cleanAnsi(`${result.stdout}\n${result.stderr}`);
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  const paths: string[] = [];
  for (const line of lines) {
    // Heuristic: accept lines that look like absolute File Cabinet paths
    if (line.startsWith('/')) {
      const p = line.replace(/\\/g, '/').replace(/\s+$/g, '');
      paths.push(p);
    }
  }
  // Deduplicate
  return Array.from(new Set(paths));
}

export interface ImportFilesOptions {
  excludeProperties?: boolean;
}

export async function importFiles(remotePaths: string[], options?: ImportFilesOptions, token?: vscode.CancellationToken): Promise<SuiteCloudResult> {
  return importFilesIn(findSdfRoot(), remotePaths, options, token);
}

export async function importFilesIn(cwd: string, remotePaths: string[], options?: ImportFilesOptions, token?: vscode.CancellationToken): Promise<SuiteCloudResult> {
  const args: string[] = ['file:import'];
  if (options?.excludeProperties) {
    args.push('--excludeproperties');
  }
  args.push('--paths', ...remotePaths);
  return runSuiteCloudIn(cwd, args, token);
}

export async function importFolder(folderPath: string, options?: ImportFilesOptions, token?: vscode.CancellationToken): Promise<SuiteCloudResult> {
  // Expand folder into file list to be robust across CLI versions
  const all = await listFileCabinetPaths(folderPath);
  const files = all.filter(p => /\/[^/]+\.[^/]+$/i.test(p));
  if (files.length === 0) {
    throw new SuiteCloudError(`No files found under folder: ${folderPath}`);
  }
  return importFiles(files, options, token);
}

export async function uploadFiles(remotePaths: string[], token?: vscode.CancellationToken): Promise<SuiteCloudResult> {
  return uploadFilesIn(findSdfRoot(), remotePaths, token);
}

export async function uploadFilesIn(cwd: string, remotePaths: string[], token?: vscode.CancellationToken): Promise<SuiteCloudResult> {
  const args: string[] = ['file:upload'];
  args.push('--paths', ...remotePaths);
  return runSuiteCloudIn(cwd, args, token);
}

export interface ImportObjectOptions {
  type: string;
  scriptIds?: string[];
  destinationFolder: string; // must start with /Objects
  excludeFiles?: boolean;
  appId?: string;
}

export async function importObjectIn(cwd: string, options: ImportObjectOptions, token?: vscode.CancellationToken): Promise<SuiteCloudResult> {
  const args: string[] = ['object:import'];
  args.push('--type', options.type);
  if (options.scriptIds && options.scriptIds.length > 0) {
    args.push('--scriptid', ...options.scriptIds);
  }
  args.push('--destinationfolder', options.destinationFolder);
  if (options.excludeFiles) args.push('--excludefiles');
  if (options.appId) {
    args.push('--appid', options.appId);
  }
  return runSuiteCloudIn(cwd, args, token);
}

export interface DeployProjectOptions {
  dryRun?: boolean;
  validate?: boolean;
  logPath?: string;
}

export async function deployProjectIn(cwd: string, options?: DeployProjectOptions, token?: vscode.CancellationToken): Promise<SuiteCloudResult> {
  const args: string[] = ['project:deploy'];
  if (options?.dryRun) args.push('--dryrun');
  if (options?.validate) args.push('--validate');
  if (options?.logPath) {
    args.push('--log', options.logPath);
  }
  return runSuiteCloudIn(cwd, args, token);
}

export async function addProjectDependenciesIn(cwd: string, token?: vscode.CancellationToken): Promise<SuiteCloudResult> {
  const args: string[] = ['project:adddependencies'];
  return runSuiteCloudIn(cwd, args, token);
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

export function getLocalPathForRemote(remotePath: string): string {
  const root = findSdfRoot();
  const normalized = remotePath.replace(/^\/+/, '');
  return path.join(root, 'FileCabinet', normalized);
}

export interface AuthAccount {
  authId: string;
  raw: string;
}

export async function listAuthAccounts(): Promise<AuthAccount[]> {
  const result = await runSuiteCloud(['account:manageauth', '--list']);
  const text = `${result.stdout}\n${result.stderr}`.trim();
  const ansiRegex = /\u001b\[[0-?]*[ -\/]*[@-~]/g; // ESC[ ... command
  const bareCsiRegex = /(?:^|\s)\[(?:\d+;?)*[A-Za-z](?=\s|$)/g; // e.g. "[2K" or "[1G"
  const clean = (s: string): string => s
    .replace(ansiRegex, '')
    .replace(bareCsiRegex, ' ')
    .replace(/[\r\t]/g, '')
    .trim();
  const lines = text
    .split(/\r?\n/)
    .map(l => clean(l))
    .filter(l => l.length > 0);
  const accounts: AuthAccount[] = [];
  for (const line of lines) {
    const firstPipe = line.indexOf('|');
    const idPart = firstPipe >= 0 ? line.slice(0, firstPipe) : line;
    const authId = idPart.trim();
    if (authId) {
      accounts.push({ authId, raw: line });
    }
  }
  return accounts;
}

export function getProjectJsonPath(): string {
  const root = findSdfRoot();
  return path.join(root, 'project.json');
}

export function readProjectDefaultAuthId(): string | undefined {
  const projectJsonPath = getProjectJsonPath();
  if (!fs.existsSync(projectJsonPath)) return undefined;
  try {
    const content = fs.readFileSync(projectJsonPath, 'utf8');
    const json = JSON.parse(content);
    const val = json?.defaultAuthId;
    return typeof val === 'string' && val.trim().length > 0 ? val : undefined;
  } catch {
    return undefined;
  }
}

export function setProjectDefaultAuthId(authId: string): void {
  const out = getOutputChannel();
  const projectJsonPath = getProjectJsonPath();
  if (!fs.existsSync(projectJsonPath)) {
    throw new SuiteCloudError(`project.json not found at ${projectJsonPath}`);
  }
  const raw = fs.readFileSync(projectJsonPath, 'utf8');
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch (e: any) {
    throw new SuiteCloudError(`Failed to parse project.json: ${e?.message || e}`);
  }
  json.defaultAuthId = authId;
  const updated = JSON.stringify(json, null, 2) + '\n';
  fs.writeFileSync(projectJsonPath, updated, 'utf8');
  out.appendLine(`[account] Updated defaultAuthId -> ${authId}`);
}

export function isProduction(authId: string, raw?: string): boolean {
  const upper = (authId || '').toUpperCase();
  if (/[_-]SB\d*/i.test(authId)) return false; // common sandbox pattern in authId
  if (upper.includes('SANDBOX') || upper.includes('SAND')) return false;
  if (raw) {
    if (/\bsb\d+\./i.test(raw)) return false; // domain has sbX
  }
  return true; // default to production if not detected as sandbox
}