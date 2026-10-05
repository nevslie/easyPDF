/**
 * "Burns in" annotations: draws each annotation's appearance into the page
 * content and removes the annotation. Text boxes then become regular page text
 * (selectable and searchable, but no longer editable as annotations).
 */
import {
	PDFArray,
	PDFDict,
	PDFDocument,
	PDFName,
	PDFNumber,
	PDFRef,
	PDFStream,
	concatTransformationMatrix,
	drawObject,
	popGraphicsState,
	pushGraphicsState,
	setGraphicsState,
} from "pdf-lib";

/** Interactive annotations that stay (links keep working, form fields stay fillable). */
const KEEP_SUBTYPES = new Set(["Link", "Widget", "Popup"]);
const FLAG_HIDDEN = 1 << 1;
const FLAG_NOVIEW = 1 << 5;

export interface FlattenResult {
	bytes: Uint8Array;
	/** Number of annotations burned into the pages. */
	flattened: number;
	/** Visible annotations without appearance stream (left untouched). */
	skipped: number;
}

export async function flattenAnnotations(input: Uint8Array): Promise<FlattenResult> {
	const pdf = await PDFDocument.load(input, { updateMetadata: false });
	const ctx = pdf.context;
	let flattened = 0;
	let skipped = 0;

	for (const page of pdf.getPages()) {
		const annots = page.node.Annots();
		if (!annots) continue;

		const removed = new Set<PDFRef | PDFDict>();
		for (let i = 0; i < annots.size(); i++) {
			const entry = annots.get(i);
			const annot = ctx.lookupMaybe(entry, PDFDict);
			if (!annot) continue;
			const subtype = annot.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText() ?? "";
			if (KEEP_SUBTYPES.has(subtype)) continue;
			const flags = annot.lookupMaybe(PDFName.of("F"), PDFNumber)?.asNumber() ?? 0;
			if (flags & (FLAG_HIDDEN | FLAG_NOVIEW)) continue;

			const appearance = normalAppearance(annot);
			const rect = numbers(annot.lookupMaybe(PDFName.of("Rect"), PDFArray));
			if (!appearance || rect?.length !== 4) {
				skipped++;
				continue;
			}

			const { stream, ref } = appearance;
			stream.dict.set(PDFName.of("Type"), PDFName.of("XObject"));
			stream.dict.set(PDFName.of("Subtype"), PDFName.of("Form"));
			const bbox = numbers(stream.dict.lookupMaybe(PDFName.of("BBox"), PDFArray));
			const matrix = numbers(stream.dict.lookupMaybe(PDFName.of("Matrix"), PDFArray)) ?? [1, 0, 0, 1, 0, 0];
			if (bbox?.length !== 4 || matrix.length !== 6) {
				skipped++;
				continue;
			}
			const cm = appearanceToRect(bbox, matrix, rect);
			if (!cm) {
				// Zero-sized appearance: nothing visible to burn in.
				removed.add(entry as PDFRef | PDFDict);
				continue;
			}

			const ops = [pushGraphicsState()];
			const opacity = annot.lookupMaybe(PDFName.of("CA"), PDFNumber)?.asNumber();
			if (opacity !== undefined && opacity < 1) {
				const gs = page.node.newExtGState("EasyPdfGS", ctx.obj({ Type: "ExtGState", CA: opacity, ca: opacity }));
				ops.push(setGraphicsState(gs));
			}
			const name = page.node.newXObject("EasyPdfAnnot", ref);
			ops.push(concatTransformationMatrix(...cm), drawObject(name), popGraphicsState());
			page.pushOperators(...ops);

			removed.add(entry as PDFRef | PDFDict);
			const popup = annot.get(PDFName.of("Popup"));
			if (popup instanceof PDFRef) removed.add(popup);
			flattened++;
		}

		if (removed.size === 0) continue;
		const keep = annots.asArray().filter((entry) => {
			if (removed.has(entry as PDFRef | PDFDict)) return false;
			// Popups whose parent annotation was burned in.
			const parent = ctx.lookupMaybe(entry, PDFDict)?.get(PDFName.of("Parent"));
			return !(parent instanceof PDFRef && removed.has(parent));
		});
		page.node.set(PDFName.of("Annots"), ctx.obj(keep));
	}

	return { bytes: await pdf.save(), flattened, skipped };
}

/** The normal appearance stream (/AP /N, or the state selected by /AS). */
function normalAppearance(annot: PDFDict): { stream: PDFStream; ref: PDFRef } | null {
	const ap = annot.lookupMaybe(PDFName.of("AP"), PDFDict);
	if (!ap) return null;
	let n = ap.get(PDFName.of("N"));
	const nDict = n instanceof PDFRef ? annot.context.lookup(n) : n;
	if (nDict instanceof PDFDict && !(nDict instanceof PDFStream)) {
		const state = annot.lookupMaybe(PDFName.of("AS"), PDFName);
		if (!state) return null;
		n = nDict.get(state);
	}
	if (!(n instanceof PDFRef)) return null;
	const stream = annot.context.lookup(n);
	return stream instanceof PDFStream ? { stream, ref: n } : null;
}

function numbers(arr: PDFArray | undefined): number[] | undefined {
	if (!arr) return undefined;
	const out: number[] = [];
	for (let i = 0; i < arr.size(); i++) {
		const v = arr.lookupMaybe(i, PDFNumber);
		if (!v) return undefined;
		out.push(v.asNumber());
	}
	return out;
}

/**
 * Matrix that maps the (Matrix-transformed) BBox of the appearance onto the
 * annotation's Rect, as described in PDF 32000-1, 12.5.5. The form's own
 * /Matrix is applied by the Do operator itself.
 */
function appearanceToRect(
	bbox: number[],
	[a, b, c, d, e, f]: number[],
	rect: number[],
): [number, number, number, number, number, number] | null {
	const xs: number[] = [];
	const ys: number[] = [];
	for (const [x, y] of [
		[bbox[0], bbox[1]],
		[bbox[0], bbox[3]],
		[bbox[2], bbox[1]],
		[bbox[2], bbox[3]],
	]) {
		xs.push(a * x + c * y + e);
		ys.push(b * x + d * y + f);
	}
	const bx1 = Math.min(...xs);
	const by1 = Math.min(...ys);
	const bw = Math.max(...xs) - bx1;
	const bh = Math.max(...ys) - by1;
	const rx1 = Math.min(rect[0], rect[2]);
	const ry1 = Math.min(rect[1], rect[3]);
	const rw = Math.abs(rect[2] - rect[0]);
	const rh = Math.abs(rect[3] - rect[1]);
	if (bw <= 0 || bh <= 0 || rw <= 0 || rh <= 0) return null;
	const sx = rw / bw;
	const sy = rh / bh;
	return [sx, 0, 0, sy, rx1 - bx1 * sx, ry1 - by1 * sy];
}
