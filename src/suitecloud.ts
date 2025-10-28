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
    var currentlyOpenTabfilePath = vscode.window.activeTextEditor?.document.fileName;
    if (!currentlyOpenTabfilePath) {
    log('[root] No active editor');
      throw new Error('No active editor');
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(currentlyOpenTabfilePath));
    if (!workspaceFolder) {
    log('[root] No workspace folder for active file');
      throw new Error('Open a workspace containing your SuiteCloud project.');
    }

  let dir = path.resolve(workspaceFolder.uri.fsPath);
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

  log('[root] manifest.xml not found');
  throw new SuiteCloudError('Could not locate SuiteCloud project (manifest.xml not found).');
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

export async function uploadFiles(remotePaths: string[], token?: vscode.CancellationToken): Promise<SuiteCloudResult> {
  return uploadFilesIn(findSdfRoot(), remotePaths, token);
}

export async function uploadFilesIn(cwd: string, remotePaths: string[], token?: vscode.CancellationToken): Promise<SuiteCloudResult> {
  const args: string[] = ['file:upload'];
  args.push('--paths', ...remotePaths);
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