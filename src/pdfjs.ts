/**
 * Bundled pdf.js (the engine behind Firefox's PDF viewer and editor).
 *
 * The build rewrites pdf.js so that it does not publish itself as
 * `globalThis.pdfjsLib` – Obsidian uses that global for its own copy.
 */
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import * as pdfjsViewer from "pdfjs-dist/legacy/web/pdf_viewer.mjs";
import workerSource from "easypdf:worker";
import bundledAssets from "easypdf:assets";

export { pdfjsLib, pdfjsViewer };

export const EditorType = pdfjsLib.AnnotationEditorType;
export const ParamType = pdfjsLib.AnnotationEditorParamsType;

let workerUrl: string | null = null;
let workerPort: Worker | null = null;

/** Starts the (shared) pdf.js worker from the bundled source. */
function ensureWorker(): void {
	if (workerPort) return;
	workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
	workerPort = new Worker(workerUrl, { type: "module", name: "easypdf-worker" });
	pdfjsLib.GlobalWorkerOptions.workerPort = workerPort;
}

export function destroyWorker(): void {
	workerPort?.terminate();
	workerPort = null;
	if (workerUrl) URL.revokeObjectURL(workerUrl);
	workerUrl = null;
	pdfjsLib.GlobalWorkerOptions.workerPort = null;
}

/**
 * Serves standard fonts and wasm image decoders from the bundle instead of
 * fetching them from a server (pdf.js would otherwise need URLs for them).
 */
class BundledDataFactory {
	constructor(_options: unknown) {}

	async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
		const data = bundledAssets.get(`${kind}/${filename}`);
		if (!data) throw new Error(`easyPDF: bundled ${kind} "${filename}" not available`);
		// The worker may take ownership of the buffer, so always hand out a copy.
		return data.slice();
	}
}

export function loadDocument(data: Uint8Array): pdfjsLib.PDFDocumentLoadingTask {
	ensureWorker();
	return pdfjsLib.getDocument({
		data,
		// Keys only – the actual bytes come from BundledDataFactory.
		standardFontDataUrl: "standardFontDataUrl/",
		wasmUrl: "wasmUrl/",
		useWorkerFetch: false,
		// Not part of the public typings, but supported by getDocument().
		...({ BinaryDataFactory: BundledDataFactory } as object),
		enableXfa: false,
	});
}
