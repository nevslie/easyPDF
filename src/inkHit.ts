/**
 * Finds the drawing (ink annotation) whose *line* is under the pointer.
 *
 * pdf.js gives every drawing a rectangular box that swallows all clicks. We make those boxes
 * click-through (see styles.css) and use this to decide when a click really hits a line.
 */

/** Extra hit area (CSS px) around a drawn line that still counts as "on the line". */
const TOLERANCE = 6;

export interface InkHit {
	/** The pdf.js editor div (drawings added/edited in this session), if any. */
	editorEl: HTMLElement | null;
	/** Id pdf.js uses in "switchannotationeditormode" to select this drawing. */
	editId: string;
}

export interface InkHitOptions {
	/** Which pdf.js ink editors to test. */
	editors: "all" | "selected" | "none";
	/** Also test drawings that are stored in the PDF and not yet turned into editors. */
	annotations: boolean;
}

type PdfjsEditor = { _drawId?: number | null; uid?: string };

export class InkHitTester {
	private samples = new WeakMap<SVGGeometryElement, { key: string; step: number; pts: Float32Array }>();

	constructor(private getEditor: (id: string) => unknown) {}

	find(target: EventTarget | null, x: number, y: number, opts: InkHitOptions): InkHit | null {
		const page = (target as Element | null)?.closest?.(".page");
		if (!page) return null;

		const editorLayer = page.querySelector(".annotationEditorLayer");
		if (opts.editors !== "none" && editorLayer && !editorLayer.classList.contains("drawing")) {
			const selector = opts.editors === "selected" ? ":scope > .inkEditor.selectedEditor" : ":scope > .inkEditor";
			const inks = Array.from(editorLayer.querySelectorAll<HTMLElement>(selector));
			// Topmost first.
			for (let i = inks.length - 1; i >= 0; i--) {
				const div = inks[i];
				if (!nearRect(div, x, y)) continue;
				const editor = this.getEditor(div.id) as PdfjsEditor | undefined;
				if (editor && this.editorHit(div, editor, x, y)) return { editorEl: div, editId: editor.uid ?? div.id };
			}
		}

		if (opts.annotations) {
			const sections = Array.from(page.querySelectorAll<HTMLElement>(".annotationLayer section.inkAnnotation"));
			for (let i = sections.length - 1; i >= 0; i--) {
				const section = sections[i];
				const editId = section.dataset.annotationId;
				if (!editId || !nearRect(section, x, y)) continue;
				for (const line of Array.from(section.querySelectorAll<SVGGeometryElement>("polyline, path"))) {
					const ctm = line.getScreenCTM();
					if (!ctm) continue;
					// Stroke width is in PDF units here and scales with the page.
					const width = (parseFloat(getComputedStyle(line).strokeWidth) || 1) * screenScale(ctm);
					if (this.lineHit(line, line, ctm, width, x, y)) return { editorEl: null, editId };
				}
			}
		}
		return null;
	}

	private editorHit(div: HTMLElement, editor: PdfjsEditor, x: number, y: number): boolean {
		// The line lives in pdf.js' draw layer as <svg><defs><path id="path_N"/></defs><use/></svg>.
		const drawId = editor._drawId;
		if (drawId === null || drawId === undefined) return false;
		const path = div.ownerDocument.getElementById(`path_${drawId}`);
		if (!(path instanceof SVGPathElement)) return false;
		const svg = path.ownerSVGElement;
		const ctm = svg?.querySelector<SVGUseElement>(":scope > use")?.getScreenCTM();
		if (!svg || !ctm) return false;
		// "non-scaling-stroke": the width is already in screen pixels.
		const width = parseFloat(getComputedStyle(svg).strokeWidth) || 1;
		return this.lineHit(path, path, ctm, width, x, y);
	}

	private lineHit(geom: SVGGeometryElement, keyEl: Element, ctm: DOMMatrix, width: number, x: number, y: number): boolean {
		const tol = width / 2 + TOLERANCE;
		// Sample the line every ~2 screen pixels.
		const pts = this.sample(geom, keyEl, 2 / screenScale(ctm));
		for (let i = 0; i < pts.length; i += 2) {
			const px = pts[i];
			const py = pts[i + 1];
			const dx = ctm.a * px + ctm.c * py + ctm.e - x;
			const dy = ctm.b * px + ctm.d * py + ctm.f - y;
			if (dx * dx + dy * dy <= tol * tol) return true;
		}
		return false;
	}

	/** Points along the line (in its own coordinates), cached until the line or zoom changes. */
	private sample(geom: SVGGeometryElement, keyEl: Element, step: number): Float32Array {
		const key = keyEl.getAttribute("d") ?? keyEl.getAttribute("points") ?? "";
		const cached = this.samples.get(geom);
		if (cached && cached.key === key && cached.step <= step * 1.5 && cached.step >= step / 1.5) return cached.pts;
		let length = 0;
		try {
			length = geom.getTotalLength();
		} catch {
			/* empty line */
		}
		const count = Math.min(20000, Math.max(1, Math.ceil(length / step)));
		const pts = new Float32Array((count + 1) * 2);
		for (let i = 0; i <= count && length > 0; i++) {
			const p = geom.getPointAtLength((length * i) / count);
			pts[2 * i] = p.x;
			pts[2 * i + 1] = p.y;
		}
		this.samples.set(geom, { key, step, pts });
		return pts;
	}
}

function screenScale(ctm: DOMMatrix): number {
	return Math.max(Math.hypot(ctm.a, ctm.b), Math.hypot(ctm.c, ctm.d)) || 1;
}

function nearRect(el: Element, x: number, y: number): boolean {
	const r = el.getBoundingClientRect();
	if (r.width === 0 && r.height === 0) return false;
	const pad = TOLERANCE + 20;
	return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
}
