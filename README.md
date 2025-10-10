## VSCode NetSuite TypeScript Uploader

Upload and compare NetSuite SuiteScripts directly from VS Code. Designed for TypeScript-first projects: compile, diff against the account, and upload with production safeguards.

### Requirements

- **SuiteCloud CLI** (`suitecloud`) installed and on your `PATH`.
- Open a workspace that contains a SuiteCloud project. The extension will look for a `manifest.xml` at the workspace root or in `src/`.
- Ensure you have logged into your accounts via `suitecloud account:manageauth`
- A `FileCabinet/SuiteScripts/` folder at the project root.
- For TypeScript projects: `tsc` available (preferably via `node_modules/.bin/tsc`) and configured to emit JavaScript next to the source files.

### Features

- **Status bar account indicator**: Shows the current `defaultAuthId`. Production accounts are highlighted with a warning style. Click to change accounts.
- **Compare current file with account**: Downloads the remote file into a temporary project and opens a diff.
  - If the file is `.ts` and `compareAsJs` is enabled, the extension compiles to `.js` and compares JavaScript output.
- **Upload current file**: Compiles `.ts` to `.js` (if applicable) and uploads the relevant file(s).
  - When uploading to production (or when forced to confirm), opens a diff and asks for confirmation before upload.
- **Compare & Upload**: One flow to review changes then upload.

### Commands

- `ns.compareCurrentFileWithAccount` — NetSuite: Compare Current File With Account
- `ns.compareAndUploadCurrentFileToAccount` — NetSuite: Compare and Upload Current File To Account
- `ns.uploadCurrentFileToAccount` — NetSuite: Upload Current File To Account
- `ns.changeAccount` — NetSuite: Change Account

You can trigger these from the Command Palette or assign keybindings. The extension activates on command usage.

### Settings

- `vscode-ns-ts.compareAsJs` (default: `true`)
  - When comparing a `.ts` file, transpile to `.js` and compare the JavaScript output.
- `vscode-ns-ts.productionUploadProtection` (default: `true`)
  - If enabled and the current account looks like production, the extension will compile, open a TS↔JS/JS↔JS diff, and require explicit confirmation before uploading.

### How file mapping works

- Only files inside `FileCabinet/SuiteScripts` are supported.
- Remote paths are derived from the file’s relative path within that folder: `/SuiteScripts/<relative-path>`.
- For `.ts` sources, the companion `.js` path is also used (e.g., `script.ts` → `script.js`).

### Typical usage

1. Open a `.ts` or `.js` file under `FileCabinet/SuiteScripts` in your SuiteCloud project.
2. Ensure `project.json` has a `defaultAuthId` for your target account. Use "NetSuite: Change Account" if needed.
3. Run one of the commands:
   - Compare with account to review differences.
   - Upload current file to push changes.
   - Compare & Upload to review and then confirm an upload in one flow.

### Troubleshooting

- "Could not locate SuiteCloud project (manifest.xml not found)."
  - Open a workspace at your SuiteCloud project root, ensuring `manifest.xml` exists at the root or under `src/`.
- "SuiteScripts folder not found at project root."
  - Create `FileCabinet/SuiteScripts/` at the project root and keep your SuiteScripts within it.
- "TypeScript compile did not emit JavaScript next to the source file."
  - Adjust your `tsconfig.json` to emit `.js` next to `.ts`, or ensure the emitted `.js` is available alongside the source.
- "No SuiteCloud auth accounts found."
  - Run `suitecloud account:manageauth` to add or list accounts, then set `defaultAuthId` via the "NetSuite: Change Account" command.