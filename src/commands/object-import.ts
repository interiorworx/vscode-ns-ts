import path from "path";
import { getOutputChannel, listObjects, ListedObject, findSdfRoot, importObjectIn } from "../suitecloud";
import * as vscode from 'vscode';
import * as fs from 'fs';

export async function importObjectsFromAccount(progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) {
    const out = getOutputChannel();
    progress.report({ message: 'Listing objects from account...' });

    const allObjects = await listObjects(undefined, undefined, token);
    out.appendLine(`[obj-import] Total objects listed: ${allObjects.length}`);

    type ObjItem = vscode.QuickPickItem & { itemType: 'type' | 'object' | 'action'; typeId?: string; scriptId?: string };
    const qp = vscode.window.createQuickPick<ObjItem>();
    qp.title = 'Import Object(s) From Account';
    qp.placeholder = 'Type to search objects (root searches all types)';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.ignoreFocusOut = true;

    let currentTypeId: string | undefined = undefined;


    function getFriendlyType(typeId: string): string {
        return FRIENDLY_TYPE_NAMES[typeId] || typeId;
    }

    function listObjectsOfType(typeId?: string): ListedObject[] {
        return typeId ? allObjects.filter(o => o.type === typeId) : allObjects;
    }

    function objectExistsLocally(typeId: string, scriptId: string): boolean {
        try {
            const root = path.resolve(findSdfRoot());
            const typeDir = path.join(root, 'Objects', typeId);
            if (!fs.existsSync(typeDir)) return false;
            const expectedPath = path.join(typeDir, `${scriptId}.xml`);
            return fs.existsSync(expectedPath);
        } catch { }
        return false;
    }

    function countObjectOverwrites(targets: ListedObject[]): number {
        return targets.filter(t => objectExistsLocally(t.type, t.scriptId)).length;
    }

    function compareTypeIds(a: string, b: string): number {
        const ai = TYPE_SORT_ORDER.indexOf(a);
        const bi = TYPE_SORT_ORDER.indexOf(b);
        const ar = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
        const br = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
        if (ar !== br) return ar - br;
        const af = getFriendlyType(a).toLowerCase();
        const bf = getFriendlyType(b).toLowerCase();
        return af.localeCompare(bf);
    }

    function sortTypeIds(types: string[]): string[] {
        return types.sort(compareTypeIds);
    }

    function normalizeImportedObjectFilenames(typeId: string, scriptIds: string[]): void {
        const root = path.resolve(findSdfRoot());
        const typeDir = path.join(root, 'Objects', typeId);
        if (!fs.existsSync(typeDir)) return;
        for (const scriptId of scriptIds) {
            const originalPath = path.join(typeDir, `${scriptId}.xml`);
            if (!fs.existsSync(originalPath)) continue;
            const targetPath = path.join(typeDir, `${scriptId}.xml`);
            try {
                if (originalPath !== targetPath) {
                    if (fs.existsSync(targetPath)) fs.rmSync(targetPath, { force: true });
                    fs.renameSync(originalPath, targetPath);
                }
            } catch { }
        }
    }

    function ensureTypeFolderExists(typeId: string): void {
        try {
            const root = path.resolve(findSdfRoot());
            const typeDir = path.join(root, 'Objects', typeId);
            if (!fs.existsSync(typeDir)) fs.mkdirSync(typeDir, { recursive: true });
        } catch { }
    }

    function chunkArray<T>(arr: T[], size: number): T[][] {
        const chunks: T[][] = [];
        for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
        return chunks;
    }

    function throwIfCancelled(tok?: vscode.CancellationToken): void {
        const t = tok ?? token;
        if (t.isCancellationRequested) {
            const anyVscode: any = vscode as any;
            if (anyVscode && anyVscode.CancellationError) throw new anyVscode.CancellationError();
            throw new Error('Canceled');
        }
    }

    async function confirmOverwriteIfNeeded(targets: ListedObject[], message: string): Promise<boolean> {
        const overwrite = countObjectOverwrites(targets);
        if (overwrite === 0) return true;
        const ok = await vscode.window.showWarningMessage(`${message.replace('{n}', String(overwrite))}`, { modal: true }, 'Yes', 'No');
        return ok === 'Yes';
    }

    async function importChunksForType(typeId: string, scriptIds: string[], total: number, processedRef: { value: number }, prog: vscode.Progress<{ message?: string; increment?: number }>, tok: vscode.CancellationToken): Promise<void> {
        ensureTypeFolderExists(typeId);
        const chunkSize = 10;
        for (const ids of chunkArray(scriptIds, chunkSize)) {
            throwIfCancelled(tok);
            const start = processedRef.value + 1;
            const end = Math.min(processedRef.value + ids.length, total);
            prog.report({ message: `Importing ${typeId} (${start}-${end} of ${total})`, increment: (ids.length / total) * 100 });
            await importObjectIn(findSdfRoot(), { type: typeId, scriptIds: ids, destinationFolder: `/Objects/${typeId}`, excludeFiles: true }, tok);
            normalizeImportedObjectFilenames(typeId, ids);
            processedRef.value += ids.length;
        }
    }

	const TYPE_SORT_ORDER: string[] = [
		'customrecordtype',
		'customlist',
		'clientscript',
		'mapreducescript',
		'massupdatescript',
		'restlet',
		'scheduledscript',
		'suitelet',
		'usereventscript',
		'sdfinstallationscript',
		'bundleinstallationscript',
		'workflowactionscript',
		'portlet',
	];

    const refreshBrowse = () => {
        qp.value = '';
        const items: ObjItem[] = [];
        if (!currentTypeId) {
            // root: list types (discovered) and allow Import ALL
            items.push({ label: '$(cloud-download) Import all objects', description: 'All types', itemType: 'action' });
			const uniqueTypes = sortTypeIds(Array.from(new Set(allObjects.map(o => o.type))));
            for (const typeId of uniqueTypes) {
                items.push({ label: `$(folder) ${getFriendlyType(typeId)}`, description: typeId, itemType: 'type', typeId });
            }
        } else {
            // within a type
            items.push({ label: '$(arrow-left) ..', description: 'Back to all types', itemType: 'type' });
            items.push({ label: '$(cloud-download) Import all in this type', description: currentTypeId, itemType: 'action', typeId: currentTypeId });
            const objs = listObjectsOfType(currentTypeId).sort((a, b) => a.scriptId.localeCompare(b.scriptId));
            for (const o of objs) {
                items.push({ label: `$(file) ${o.scriptId}`, description: o.rawType, itemType: 'object', typeId: o.type, scriptId: o.scriptId });
            }
        }
        qp.items = items;
    };

    const refreshSearch = (query: string) => {
        const q = query.toLowerCase();
        const scope = listObjectsOfType(currentTypeId);
        const typeSet = new Set(allObjects.map(o => o.type));
        const typeItems: ObjItem[] = Array.from(typeSet)
            .filter(t => t.toLowerCase().includes(q) || getFriendlyType(t).toLowerCase().includes(q))
            .sort(compareTypeIds)
            .map(t => ({
                label: `$(folder) ${getFriendlyType(t)}`,
                description: t,
                itemType: 'type',
                typeId: t,
            } as ObjItem));

        const matched = scope.filter(o => o.scriptId.toLowerCase().includes(q) || o.rawType.toLowerCase().includes(q) || o.type.toLowerCase().includes(q)).slice(0, 300);
        const objectItems: ObjItem[] = matched.map(o => ({
            label: `$(file) ${o.scriptId}`,
            description: o.rawType,
            itemType: 'object',
            typeId: o.type,
            scriptId: o.scriptId,
        }));
        const items: ObjItem[] = [ ...typeItems, ...objectItems ];
        qp.items = items.length ? items : [{ label: 'No results', itemType: 'action' } as ObjItem];
    };

    qp.onDidChangeValue((val) => {
        if (val && val.trim().length > 0) {
            refreshSearch(val.trim());
        } else {
            refreshBrowse();
        }
    });

    qp.onDidAccept(async () => {
        const picked = qp.selectedItems[0] as ObjItem | undefined;
        if (!picked) return;
        if (!currentTypeId && picked.itemType === 'type' && picked.typeId) {
            currentTypeId = picked.typeId;
            refreshBrowse();
            return;
        }
        if (currentTypeId && picked.itemType === 'type' && !picked.typeId) {
            // Back
            currentTypeId = undefined;
            refreshBrowse();
            return;
        }

        if (picked.itemType === 'type' && picked.typeId) {
            currentTypeId = picked.typeId;
            refreshBrowse();
            return;
        }

        // Import actions
        if (picked.itemType === 'action') {
            qp.busy = true;
            try {
                if (!currentTypeId && !picked.typeId && picked.label.includes('Import all objects')) {
                    const targets = allObjects;
                    const proceed = await confirmOverwriteIfNeeded(targets, 'Importing all objects will overwrite {n} local file(s). Continue?');
                    if (!proceed) { qp.busy = false; return; }
                    qp.hide();
                    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'NetSuite', cancellable: true }, async (progress2, token2) => {
                        // group by type and import in chunks with progress and cancellation
                        const byType = new Map<string, string[]>();
                        for (const t of targets) {
                            if (!byType.has(t.type)) byType.set(t.type, []);
                            byType.get(t.type)!.push(t.scriptId);
                        }
                        const total = targets.length;
                        const processedRef = { value: 0 };
                        for (const [typeId, scriptIds] of byType) {
                            await importChunksForType(typeId, scriptIds, total, processedRef, progress2, token2);
                        }
                    });
                    vscode.window.showInformationMessage('Imported all supported objects.');
                    return;
                }
                if (currentTypeId && picked.typeId === currentTypeId && picked.label.includes('Import all in this type')) {
                    const targets = listObjectsOfType(currentTypeId);
                    const proceed = await confirmOverwriteIfNeeded(targets, `Importing all ${getFriendlyType(currentTypeId)} will overwrite {n} local file(s). Continue?`);
                    if (!proceed) { qp.busy = false; return; }
                    qp.hide();
                    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'NetSuite', cancellable: true }, async (progress2, token2) => {
                        const total = targets.length;
                        const scriptIds = targets.map(t => t.scriptId);
                        const processedRef = { value: 0 };
                        await importChunksForType(currentTypeId!, scriptIds, total, processedRef, progress2, token2);
                    });
                    vscode.window.showInformationMessage(`Imported all: ${getFriendlyType(currentTypeId)}`);
                    return;
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
            } finally {
                qp.busy = false;
            }
            return;
        }

        if (picked.itemType === 'object' && picked.typeId && picked.scriptId) {
            qp.busy = true;
            try {
                const target = { type: picked.typeId, scriptId: picked.scriptId } as ListedObject;
                const proceed = await confirmOverwriteIfNeeded([target], `Importing ${picked.scriptId} (${picked.typeId}) will overwrite {n} local file(s). Continue?`);
                if (!proceed) { qp.busy = false; return; }
                ensureTypeFolderExists(picked.typeId);
                await importObjectIn(findSdfRoot(), { type: picked.typeId, scriptIds: [picked.scriptId], destinationFolder: `/Objects/${picked.typeId}`, excludeFiles: true }, token);
                normalizeImportedObjectFilenames(picked.typeId, [picked.scriptId]);
                vscode.window.showInformationMessage(`Imported object: ${picked.scriptId}`);
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

const FRIENDLY_TYPE_NAMES: Record<string, string> = {
    addressform: 'Address Form',
    advancedpdftemplate: 'Advanced PDF Template',
    bankstatementparserplugin: 'Bank Statement Parser Plugin',
    bundleinstallationscript: 'Bundle Installation Script',
    center: 'Center',
    centercategory: 'Center Category',
    centerlink: 'Center Link',
    centertab: 'Center Tab',
    clientscript: 'Client Script',
    cmscontenttype: 'CMS Content Type',
    crmcustomfield: 'CRM Custom Field',
    customglplugin: 'Custom GL Plugin',
    customlist: 'Custom List',
    customrecordtype: 'Custom Record Type',
    customsegment: 'Custom Segment',
    customtransactiontype: 'Custom Transaction Type',
    dataset: 'Dataset',
    datasetbuilderplugin: 'Dataset Builder Plugin',
    emailcaptureplugin: 'Email Capture Plugin',
    emailtemplate: 'Email Template',
    entitycustomfield: 'Entity Custom Field',
    entryform: 'Entry Form',
    ficonnectivityplugin: 'FI Connectivity Plugin',
    financiallayout: 'Financial Layout',
    fiparserplugin: 'FI Parser Plugin',
    integration: 'Integration',
    itemcustomfield: 'Item Custom Field',
    itemnumbercustomfield: 'Item Number Custom Field',
    itemoptioncustomfield: 'Item Option Custom Field',
    kpiscorecard: 'KPI Scorecard',
    mapreducescript: 'Script: Map/Reduce',
    massupdatescript: 'Script: Mass Update',
    othercustomfield: 'Other Custom Field',
    plugintype: 'Plugin Type',
    plugintypeimpl: 'Plugin Type Implementation',
    portlet: 'Script: Portlet',
    publisheddashboard: 'Published Dashboard',
    reportdefinition: 'Report Definition',
    restlet: 'Script: RESTlet',
    role: 'Role',
    csvimport: 'CSV Import',
    savedsearch: 'Saved Search',
    scheduledscript: 'Script: Scheduled',
    sdfinstallationscript: 'Script: SDF Installation',
    secret: 'Secret',
    singlepageapp: 'Single Page App',
    sspapplication: 'SSP Application',
    sublist: 'Sublist',
    subtab: 'Subtab',
    suitelet: 'Script: Suitelet',
    tool: 'Tool',
    transactionform: 'Transaction Form',
    transactionbodycustomfield: 'Transaction Body Custom Field',
    transactioncolumncustomfield: 'Transaction Column Custom Field',
    translationcollection: 'Translation Collection',
    usereventscript: 'Script: User Event',
    workbook: 'Workbook',
    workbookbuilderplugin: 'Workbook Builder Plugin',
    workflow: 'Workflow',
    workflowactionscript: 'Script: Workflow Action',
};