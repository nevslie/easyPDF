import { FileView, Notice, Scope, TFile, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import type EasyPdfPlugin from "./main";
import { EditorType, ParamType, loadDocument, pdfjsLib, pdfjsViewer } from "./pdfjs";
import { HIGHLIGHT_COLORS, MAX_SIGNATURES } from "./settings";
import {
	SignatureModal,
	UnsavedChangesModal,
	VaultImageModal,
	dataUrlToFile,
	pickImageFromComputer,
	vaultImageToFile,
} from "./modals";

export const VIEW_TYPE_EASYPDF = "easypdf-editor";

/** Tools in the toolbar. "signature" is placed as an image (stamp) annotation. */
type Tool = "none" | "highlight" | "freetext" | "ink" | "stamp" | "signature";

const TOOL_MODE: Record<Tool, number> = {
	none: EditorType.NONE,
	highlight: EditorType.HIGHLIGHT,
	freetext: EditorType.FREETEXT,
	ink: EditorType.INK,
	stamp: EditorType.STAMP,
	signature: EditorType.STAMP,
};

const TOOLS: { tool: Tool; icon: string; label: string }[] = [
	{ tool: "highlight", icon: "highlighter", label: "Markieren" },
	{ tool: "freetext", icon: "type", label: "Text" },
	{ tool: "ink", icon: "pencil", label: "Zeichnen" },
	{ tool: "stamp", icon: "image-plus", label: "Bild hinzufügen" },
	{ tool: "signature", icon: "signature", label: "Unterschrift" },
];

const ZOOM_PRESETS: [string, string][] = [
	["auto", "Automatisch"],
	["page-actual", "Originalgröße"],
	["page-fit", "Ganze Seite"],
	["page-width", "Seitenbreite"],
	["0.5", "50 %"],
	["0.75", "75 %"],
	["1", "100 %"],
	["1.25", "125 %"],
	["1.5", "150 %"],
	["2", "200 %"],
	["3", "300 %"],
	["4", "400 %"],
];

type UIManager = {
	addCommands: (params: unknown) => void;
	undo: () => void;
	redo: () => void;
	endCurrentEditing: () => void;
};

export class PdfEditorView extends FileView {
	private plugin: EasyPdfPlugin;

	// pdf.js
	private eventBus: pdfjsViewer.EventBus | null = null;
	private pdfViewer: pdfjsViewer.PDFViewer | null = null;
	private linkService: pdfjsViewer.PDFLinkService | null = null;
	private findController: pdfjsViewer.PDFFindController | null = null;
	private loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;
	private pdfDocument: pdfjsLib.PDFDocumentProxy | null = null;
	private uiManager: UIManager | null = null;
	private abortController: AbortController | null = null;

	// DOM
	private toolbarEl!: HTMLElement;
	private paramsBarEl!: HTMLElement;
	private viewerContainerEl!: HTMLDivElement;
	private viewerEl!: HTMLDivElement;
	private messageEl!: HTMLElement;
	private pageInput!: HTMLInputElement;
	private pageCountEl!: HTMLElement;
	private zoomSelect!: HTMLSelectElement;
	private customZoomOption!: HTMLOptionElement;
	private findInput!: HTMLInputElement;
	private findResultEl!: HTMLElement;
	private findBarEl!: HTMLElement;
	private toolButtons = new Map<Tool, HTMLElement>();
	private undoBtn!: HTMLElement;
	private redoBtn!: HTMLElement;
	private deleteBtn!: HTMLElement;
	private saveBtn!: HTMLElement;
	private saveHeaderAction: HTMLElement | null = null;

	// State
	private tool: Tool = "none";
	private dirty = false;
	private saving: Promise<void> | null = null;
	/** Timestamp of our own last write – vault "modify" events right after it are ignored. */
	private ownWriteAt = 0;
	/** Set while switching back to Obsidian's viewer after the user chose "discard". */
	private discardOnUnload = false;
	private autoSaveDebounced: (() => void) & { cancel: () => void };

	constructor(leaf: WorkspaceLeaf, plugin: EasyPdfPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.allowNoFile = false;
		this.navigation = true;
		this.autoSaveDebounced = this.createAutoSaver();

		this.scope = new Scope(this.app.scope);
		this.scope.register(["Mod"], "s", () => {
			void this.save();
			return false;
		});
		this.scope.register(["Mod"], "f", () => {
			this.toggleFindBar(true);
			return false;
		});
	}

	getViewType(): string {
		return VIEW_TYPE_EASYPDF;
	}

	getIcon(): string {
		return "file-pen-line";
	}

	getDisplayText(): string {
		if (!this.file) return "easyPDF";
		return `${this.dirty ? "● " : ""}${this.file.basename}`;
	}

	canAcceptExtension(extension: string): boolean {
		return extension.toLowerCase() === "pdf";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("easypdf-view");

		this.toolbarEl = root.createDiv({ cls: "easypdf-toolbar" });
		this.paramsBarEl = root.createDiv({ cls: "easypdf-paramsbar easypdf-hidden" });
		this.findBarEl = root.createDiv({ cls: "easypdf-findbar easypdf-hidden" });
		const main = root.createDiv({ cls: "easypdf-main" });
		this.viewerContainerEl = main.createDiv({ cls: "easypdf-viewer-container" });
		this.viewerEl = this.viewerContainerEl.createDiv({ cls: "pdfViewer" });
		this.messageEl = main.createDiv({ cls: "easypdf-message easypdf-hidden" });

		this.buildToolbar();
		this.buildFindBar();

		this.addAction("book-open", "Bearbeiten beenden (normale PDF-Ansicht)", () => void this.exitEditing());
		this.saveHeaderAction = this.addAction("save", "Speichern (Strg+S)", () => void this.save());

		// Save as soon as the user leaves a text box. pdf.js commits the text in its own
		// focusout handler (which runs after this capturing listener), so save right after.
		this.viewerContainerEl.addEventListener(
			"focusout",
			(evt) => {
				const target = evt.target as HTMLElement | null;
				if (!this.plugin.settings.saveOnTextFieldLeave || !target?.closest(".freeTextEditor")) return;
				window.setTimeout(() => {
					if (this.dirty) void this.save(undefined, true);
				}, 150);
			},
			true,
		);

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file === this.file) void this.onExternalModify();
			}),
		);
	}

	async onClose(): Promise<void> {
		this.autoSaveDebounced.cancel();
		await this.teardownDocument();
	}

	// ---------------------------------------------------------------------------
	// Loading
	// ---------------------------------------------------------------------------

	async onLoadFile(file: TFile): Promise<void> {
		await this.openDocument(file);
	}

	async onUnloadFile(file: TFile): Promise<void> {
		this.autoSaveDebounced.cancel();
		if (this.dirty && !this.discardOnUnload && this.plugin.settings.saveOnClose) {
			await this.save(file);
		}
		this.discardOnUnload = false;
		await this.teardownDocument();
	}

	private async openDocument(file: TFile, restore?: { page: number; scale: string }): Promise<void> {
		await this.teardownDocument();
		this.showMessage("PDF wird geladen …");

		const abortController = (this.abortController = new AbortController());
		const eventBus = (this.eventBus = new pdfjsViewer.EventBus());
		const linkService = (this.linkService = new pdfjsViewer.PDFLinkService({
			eventBus,
			externalLinkTarget: pdfjsViewer.LinkTarget.BLANK,
		}));
		const findController = (this.findController = new pdfjsViewer.PDFFindController({ eventBus, linkService }));

		const pdfViewer = (this.pdfViewer = new pdfjsViewer.PDFViewer({
			container: this.viewerContainerEl,
			viewer: this.viewerEl,
			eventBus,
			linkService,
			findController,
			// Supported by PDFViewer, missing from its typings.
			...({
				abortSignal: abortController.signal,
				enableHighlightFloatingButton: true,
				supportsPinchToZoom: true,
			} as object),
			annotationEditorMode: EditorType.NONE,
			annotationEditorHighlightColors: Object.entries(HIGHLIGHT_COLORS)
				.map(([name, hex]) => `${name}=${hex}`)
				.join(","),
		}));
		linkService.setViewer(pdfViewer);
		this.bindEvents(eventBus);

		try {
			const data = new Uint8Array(await this.app.vault.readBinary(file));
			const task = (this.loadingTask = loadDocument(data));
			const pdfDocument = await task.promise;
			if (this.pdfViewer !== pdfViewer) {
				await task.destroy();
				return;
			}
			this.pdfDocument = pdfDocument;
			(pdfDocument.annotationStorage as unknown as { onSetModified: () => void }).onSetModified = () => this.markDirty();

			// Set zoom and page before the first render (like Firefox): changing them afterwards
			// re-renders the pages while their annotations may still be loading.
			eventBus.on(
				"pagesinit",
				() => {
					pdfViewer.currentScaleValue = restore?.scale ?? this.plugin.settings.defaultZoom;
					if (restore?.page) pdfViewer.currentPageNumber = Math.min(restore.page, pdfDocument.numPages);
				},
				{ once: true },
			);
			pdfViewer.setDocument(pdfDocument);
			linkService.setDocument(pdfDocument);
			await pdfViewer.pagesPromise;
			if (this.pdfViewer !== pdfViewer) return;

			this.pageCountEl.setText(`/ ${pdfDocument.numPages}`);
			this.pageInput.max = String(pdfDocument.numPages);
			this.hideMessage();
			this.setDirty(false);
			if (this.tool !== "none") await this.applyTool(this.tool);
		} catch (err) {
			if (this.pdfViewer !== pdfViewer) return;
			console.error("easyPDF: failed to load PDF", err);
			const msg =
				err instanceof pdfjsLib.PasswordException
					? "Passwortgeschützte PDFs werden noch nicht unterstützt."
					: err instanceof pdfjsLib.InvalidPDFException
						? "Die Datei ist keine gültige PDF oder beschädigt."
						: `Die PDF konnte nicht geladen werden: ${String((err as Error)?.message ?? err)}`;
			this.showMessage(msg, true);
		}
	}

	private async teardownDocument(): Promise<void> {
		this.uiManager = null;
		const task = this.loadingTask;
		this.loadingTask = null;
		if (this.pdfViewer) {
			try {
				this.pdfViewer.setDocument(null as unknown as pdfjsLib.PDFDocumentProxy);
			} catch {
				/* viewer already torn down */
			}
		}
		this.linkService?.setDocument(null);
		// Removes all listeners the viewer registered on our (reused) container.
		this.abortController?.abort();
		this.abortController = null;
		this.pdfViewer = null;
		this.findController = null;
		this.linkService = null;
		this.eventBus = null;
		this.pdfDocument = null;
		this.viewerEl?.empty();
		if (task) {
			try {
				await task.destroy();
			} catch {
				/* ignore */
			}
		}
	}

	private async onExternalModify(): Promise<void> {
		if (!this.file || Date.now() - this.ownWriteAt < 2000 || this.saving) return;
		if (this.dirty) {
			new Notice("easyPDF: Die PDF wurde außerhalb geändert. Deine ungespeicherten Änderungen bleiben erhalten; beim Speichern wird die externe Änderung überschrieben.");
			return;
		}
		await this.openDocument(this.file, this.currentPosition());
	}

	private currentPosition(): { page: number; scale: string } | undefined {
		if (!this.pdfViewer) return undefined;
		return { page: this.pdfViewer.currentPageNumber, scale: this.pdfViewer.currentScaleValue };
	}

	// ---------------------------------------------------------------------------
	// pdf.js events
	// ---------------------------------------------------------------------------

	private bindEvents(eventBus: pdfjsViewer.EventBus): void {
		eventBus.on("annotationeditoruimanager", ({ uiManager }: { uiManager: UIManager }) => {
			this.uiManager = uiManager;
			// Every user edit (add, move, resize, recolor, delete, text change …) goes through
			// addCommands; undo/redo change the document as well.
			const wrap = <K extends "addCommands" | "undo" | "redo">(name: K) => {
				const original = uiManager[name].bind(uiManager) as (...args: unknown[]) => void;
				(uiManager[name] as unknown) = (...args: unknown[]) => {
					original(...args);
					this.markDirty();
				};
			};
			wrap("addCommands");
			wrap("undo");
			wrap("redo");
		});

		eventBus.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => {
			this.pageInput.value = String(pageNumber);
		});

		eventBus.on("scalechanging", ({ scale, presetValue }: { scale: number; presetValue?: string }) => {
			this.updateZoomSelect(scale, presetValue);
		});

		eventBus.on(
			"editingstateschanged",
			({ details }: { details: { hasSomethingToUndo?: boolean; hasSomethingToRedo?: boolean; hasSelectedEditor?: boolean } }) => {
				this.setButtonEnabled(this.undoBtn, !!details.hasSomethingToUndo);
				this.setButtonEnabled(this.redoBtn, !!details.hasSomethingToRedo);
				this.setButtonEnabled(this.deleteBtn, !!details.hasSelectedEditor);
			},
		);

		// pdf.js asks to switch modes itself, e.g. when double-clicking an existing annotation.
		eventBus.on("switchannotationeditormode", (evt: { mode: number; editId?: string; isFromKeyboard?: boolean }) => {
			if (!this.pdfViewer) return;
			this.pdfViewer.annotationEditorMode = evt as never;
		});

		eventBus.on("annotationeditormodechanged", ({ mode }: { mode: number }) => {
			const expected = TOOL_MODE[this.tool];
			if (mode === expected) return;
			const tool = (Object.keys(TOOL_MODE) as Tool[]).find((t) => TOOL_MODE[t] === mode && t !== "signature") ?? "none";
			this.tool = tool;
			this.renderToolState();
		});

		// Reflect the properties of the selected annotation in the params bar (like Firefox).
		eventBus.on("annotationeditorparamschanged", ({ details }: { details: [number, unknown][] }) => {
			for (const [type, value] of details) this.reflectParam(type, value);
		});

		eventBus.on(
			"updatefindmatchescount",
			({ matchesCount }: { matchesCount: { current: number; total: number } }) => this.updateFindResult(matchesCount),
		);
		eventBus.on(
			"updatefindcontrolstate",
			({ state, matchesCount }: { state: number; matchesCount: { current: number; total: number } }) => {
				if (state === pdfjsViewer.FindState.NOT_FOUND) {
					this.findResultEl.setText("Nicht gefunden");
					this.findInput.addClass("easypdf-not-found");
				} else {
					this.findInput.removeClass("easypdf-not-found");
					this.updateFindResult(matchesCount);
				}
			},
		);
	}

	// ---------------------------------------------------------------------------
	// Toolbar
	// ---------------------------------------------------------------------------

	private button(parent: HTMLElement, icon: string, label: string, onClick: () => void, cls = ""): HTMLElement {
		const btn = parent.createEl("button", { cls: `easypdf-btn clickable-icon ${cls}`.trim(), attr: { "aria-label": label } });
		setIcon(btn, icon);
		setTooltip(btn, label, { placement: "bottom" });
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			onClick();
		});
		return btn;
	}

	private setButtonEnabled(btn: HTMLElement | undefined, enabled: boolean): void {
		if (!btn) return;
		btn.toggleClass("is-disabled", !enabled);
		(btn as HTMLButtonElement).disabled = !enabled;
	}

	private buildToolbar(): void {
		const tb = this.toolbarEl;

		// Search + navigation
		const nav = tb.createDiv({ cls: "easypdf-group" });
		this.button(nav, "search", "Im Dokument suchen (Strg+F)", () => this.toggleFindBar());
		this.button(nav, "chevron-up", "Vorherige Seite", () => this.pdfViewer?.previousPage());
		this.button(nav, "chevron-down", "Nächste Seite", () => this.pdfViewer?.nextPage());
		this.pageInput = nav.createEl("input", { cls: "easypdf-page-input", type: "number", attr: { min: "1", "aria-label": "Seite" } });
		this.pageInput.value = "1";
		this.pageInput.addEventListener("change", () => {
			const n = parseInt(this.pageInput.value, 10);
			if (this.pdfViewer && n >= 1 && n <= this.pdfViewer.pagesCount) this.pdfViewer.currentPageNumber = n;
			else if (this.pdfViewer) this.pageInput.value = String(this.pdfViewer.currentPageNumber);
		});
		this.pageCountEl = nav.createSpan({ cls: "easypdf-page-count", text: "/ –" });

		// Zoom
		const zoom = tb.createDiv({ cls: "easypdf-group" });
		this.button(zoom, "minus", "Verkleinern", () => this.pdfViewer?.decreaseScale());
		this.zoomSelect = zoom.createEl("select", { cls: "dropdown easypdf-zoom", attr: { "aria-label": "Zoom" } });
		for (const [value, text] of ZOOM_PRESETS) this.zoomSelect.createEl("option", { value, text });
		this.customZoomOption = this.zoomSelect.createEl("option", { value: "custom", text: "" });
		this.customZoomOption.hidden = true;
		this.customZoomOption.disabled = true;
		this.zoomSelect.addEventListener("change", () => {
			if (this.pdfViewer && this.zoomSelect.value !== "custom") this.pdfViewer.currentScaleValue = this.zoomSelect.value;
		});
		this.button(zoom, "plus", "Vergrößern", () => this.pdfViewer?.increaseScale());

		tb.createDiv({ cls: "easypdf-spacer" });

		// Editing tools
		const tools = tb.createDiv({ cls: "easypdf-group easypdf-tools" });
		for (const { tool, icon, label } of TOOLS) {
			const btn = this.button(tools, icon, label, () => void this.selectTool(this.tool === tool ? "none" : tool));
			btn.addClass("easypdf-tool");
			this.toolButtons.set(tool, btn);
		}

		// Actions
		const actions = tb.createDiv({ cls: "easypdf-group" });
		this.undoBtn = this.button(actions, "undo-2", "Rückgängig (Strg+Z)", () => this.editingAction("undo"));
		this.redoBtn = this.button(actions, "redo-2", "Wiederholen (Strg+Umschalt+Z)", () => this.editingAction("redo"));
		this.deleteBtn = this.button(actions, "trash-2", "Auswahl löschen (Entf)", () => this.editingAction("delete"));
		this.saveBtn = this.button(actions, "save", "Speichern (Strg+S)", () => void this.save(), "easypdf-save");
		this.setButtonEnabled(this.undoBtn, false);
		this.setButtonEnabled(this.redoBtn, false);
		this.setButtonEnabled(this.deleteBtn, false);
	}

	private buildFindBar(): void {
		const bar = this.findBarEl;
		this.findInput = bar.createEl("input", {
			type: "search",
			cls: "easypdf-find-input",
			attr: { placeholder: "Im Dokument suchen …", "aria-label": "Suchen" },
		});
		const prev = this.button(bar, "arrow-up", "Vorheriger Treffer", () => this.find("again", true));
		const next = this.button(bar, "arrow-down", "Nächster Treffer", () => this.find("again", false));
		prev.addClass("easypdf-small");
		next.addClass("easypdf-small");
		this.findResultEl = bar.createSpan({ cls: "easypdf-find-result" });
		this.button(bar, "x", "Suche schließen", () => this.toggleFindBar(false)).addClass("easypdf-small");

		this.findInput.addEventListener("input", () => this.find("", false));
		this.findInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.find("again", e.shiftKey);
			} else if (e.key === "Escape") {
				e.preventDefault();
				this.toggleFindBar(false);
			}
		});
	}

	private toggleFindBar(force?: boolean): void {
		const show = force ?? this.findBarEl.hasClass("easypdf-hidden");
		this.findBarEl.toggleClass("easypdf-hidden", !show);
		if (show) {
			this.findInput.focus();
			this.findInput.select();
		} else {
			this.eventBus?.dispatch("findbarclose", { source: this });
			this.findResultEl.setText("");
		}
	}

	private find(type: "" | "again", findPrevious: boolean): void {
		this.eventBus?.dispatch("find", {
			source: this,
			type,
			query: this.findInput.value,
			caseSensitive: false,
			entireWord: false,
			highlightAll: true,
			findPrevious,
			matchDiacritics: false,
		});
	}

	private updateFindResult(matches: { current: number; total: number }): void {
		if (!this.findInput.value) this.findResultEl.setText("");
		else if (matches.total > 0) this.findResultEl.setText(`${matches.current} von ${matches.total}`);
	}

	private updateZoomSelect(scale: number, presetValue?: string): void {
		if (presetValue && ZOOM_PRESETS.some(([v]) => v === presetValue)) {
			this.zoomSelect.value = presetValue;
			return;
		}
		const match = ZOOM_PRESETS.find(([v]) => Math.abs(Number(v) - scale) < 0.001);
		if (match) {
			this.zoomSelect.value = match[0];
		} else {
			this.customZoomOption.text = `${Math.round(scale * 100)} %`;
			this.zoomSelect.value = "custom";
		}
	}

	private editingAction(name: "undo" | "redo" | "delete"): void {
		this.eventBus?.dispatch("editingaction", { source: this, name });
	}

	// ---------------------------------------------------------------------------
	// Tools
	// ---------------------------------------------------------------------------

	async selectTool(tool: Tool): Promise<void> {
		this.tool = tool;
		this.renderToolState();
		await this.applyTool(tool);
		if (tool === "signature" && this.plugin.settings.signatures.length === 0) this.newSignature();
	}

	private async applyTool(tool: Tool): Promise<void> {
		const viewer = this.pdfViewer;
		if (!viewer?.pdfDocument || !this.uiManager) return;
		const mode = TOOL_MODE[tool];
		if (this.currentMode() !== mode) {
			const changed = this.waitForMode(mode);
			viewer.annotationEditorMode = { mode } as never;
			await changed;
		}
		this.applyDefaultParams(tool);
	}

	/** The typings declare the setter's object type for the getter too; the getter returns the mode number. */
	private currentMode(): number {
		return (this.pdfViewer?.annotationEditorMode as unknown as number | undefined) ?? EditorType.DISABLE;
	}

	private waitForMode(mode: number): Promise<void> {
		return new Promise((resolve) => {
			const bus = this.eventBus;
			if (!bus) return resolve();
			const timer = window.setTimeout(done, 3000);
			function listener({ mode: m }: { mode: number }) {
				if (m === mode) done();
			}
			function done() {
				window.clearTimeout(timer);
				bus?.off("annotationeditormodechanged", listener);
				resolve();
			}
			bus.on("annotationeditormodechanged", listener);
		});
	}

	/** Pushes the saved defaults into pdf.js (only affects new annotations when nothing is selected). */
	private applyDefaultParams(tool: Tool): void {
		const s = this.plugin.settings;
		switch (tool) {
			case "freetext":
				this.dispatchParam(ParamType.FREETEXT_COLOR, s.textColor);
				this.dispatchParam(ParamType.FREETEXT_SIZE, s.textSize);
				break;
			case "ink":
				this.dispatchParam(ParamType.INK_COLOR, s.inkColor);
				this.dispatchParam(ParamType.INK_THICKNESS, s.inkThickness);
				this.dispatchParam(ParamType.INK_OPACITY, s.inkOpacity);
				break;
			case "highlight":
				this.dispatchParam(ParamType.HIGHLIGHT_COLOR, s.highlightColor);
				this.dispatchParam(ParamType.HIGHLIGHT_THICKNESS, s.highlightThickness);
				break;
		}
	}

	private dispatchParam(type: number, value: unknown): void {
		this.eventBus?.dispatch("switchannotationeditorparams", { source: this, type, value });
	}

	private renderToolState(): void {
		for (const [tool, btn] of this.toolButtons) btn.toggleClass("is-active", tool === this.tool);
		this.contentEl.dataset.tool = this.tool;
		this.renderParamsBar();
	}

	/** Secondary bar with the options of the active tool (Firefox shows these in a dropdown). */
	private renderParamsBar(): void {
		const bar = this.paramsBarEl;
		bar.empty();
		bar.toggleClass("easypdf-hidden", this.tool === "none");
		const s = this.plugin.settings;
		const persist = () => void this.plugin.saveSettings();

		switch (this.tool) {
			case "freetext": {
				bar.createSpan({ cls: "easypdf-hint", text: "Klicke auf die Seite, um ein Textfeld einzufügen." });
				this.colorInput(bar, "Farbe", s.textColor, "freetext-color", (v) => {
					s.textColor = v;
					persist();
					this.dispatchParam(ParamType.FREETEXT_COLOR, v);
				});
				this.rangeInput(bar, "Größe", 5, 100, 1, s.textSize, "freetext-size", (v) => `${v}`, (v) => {
					s.textSize = v;
					persist();
					this.dispatchParam(ParamType.FREETEXT_SIZE, v);
				});
				break;
			}
			case "ink": {
				bar.createSpan({ cls: "easypdf-hint", text: "Mit gedrückter Maustaste oder Stift zeichnen." });
				this.colorInput(bar, "Farbe", s.inkColor, "ink-color", (v) => {
					s.inkColor = v;
					persist();
					this.dispatchParam(ParamType.INK_COLOR, v);
				});
				this.rangeInput(bar, "Dicke", 1, 20, 1, s.inkThickness, "ink-thickness", (v) => `${v}`, (v) => {
					s.inkThickness = v;
					persist();
					this.dispatchParam(ParamType.INK_THICKNESS, v);
				});
				this.rangeInput(bar, "Deckkraft", 5, 100, 5, Math.round(s.inkOpacity * 100), "ink-opacity", (v) => `${v} %`, (v) => {
					s.inkOpacity = v / 100;
					persist();
					this.dispatchParam(ParamType.INK_OPACITY, v / 100);
				});
				break;
			}
			case "highlight": {
				bar.createSpan({ cls: "easypdf-hint", text: "Text auswählen oder frei über die Seite ziehen." });
				const swatches = bar.createDiv({ cls: "easypdf-swatches", attr: { "data-param": "highlight-color" } });
				for (const [name, hex] of Object.entries(HIGHLIGHT_COLORS)) {
					const sw = swatches.createEl("button", {
						cls: "easypdf-swatch",
						attr: { "aria-label": name, "data-color": hex.toLowerCase() },
					});
					sw.style.setProperty("--swatch-color", hex);
					sw.toggleClass("is-active", hex.toLowerCase() === s.highlightColor.toLowerCase());
					setTooltip(sw, name, { placement: "bottom" });
					sw.addEventListener("click", () => {
						s.highlightColor = hex;
						persist();
						this.dispatchParam(ParamType.HIGHLIGHT_COLOR, hex);
						this.reflectParam(ParamType.HIGHLIGHT_COLOR, hex);
					});
				}
				this.rangeInput(bar, "Dicke (freies Markieren)", 8, 24, 1, s.highlightThickness, "highlight-thickness", (v) => `${v}`, (v) => {
					s.highlightThickness = v;
					persist();
					this.dispatchParam(ParamType.HIGHLIGHT_THICKNESS, v);
				});
				const showAll = bar.createEl("label", { cls: "easypdf-field" });
				const cb = showAll.createEl("input", { type: "checkbox" });
				cb.checked = true;
				showAll.appendText("Alle anzeigen");
				cb.addEventListener("change", () => this.dispatchParam(ParamType.HIGHLIGHT_SHOW_ALL, cb.checked));
				break;
			}
			case "stamp": {
				bar.createSpan({ cls: "easypdf-hint", text: "Bild einfügen, dann verschieben oder an den Ecken skalieren." });
				this.textButton(bar, "image", "Aus dem Vault …", () => {
					new VaultImageModal(this.app, async (file) => {
						try {
							await this.insertImage(await vaultImageToFile(this.app, file));
						} catch (e) {
							new Notice(`Bild konnte nicht geladen werden: ${String(e)}`);
						}
					}).open();
				});
				this.textButton(bar, "hard-drive-upload", "Vom Computer …", async () => {
					const file = await pickImageFromComputer();
					if (file) await this.insertImage(file);
				});
				break;
			}
			case "signature": {
				bar.createSpan({ cls: "easypdf-hint", text: "Gespeicherte Unterschrift anklicken, um sie einzufügen." });
				const list = bar.createDiv({ cls: "easypdf-signatures" });
				s.signatures.forEach((dataUrl, idx) => {
					const item = list.createDiv({ cls: "easypdf-signature-item" });
					const img = item.createEl("img", { attr: { src: dataUrl, alt: `Unterschrift ${idx + 1}` } });
					setTooltip(item, "Einfügen", { placement: "bottom" });
					img.addEventListener("click", async () => this.insertImage(await dataUrlToFile(dataUrl, "Unterschrift.png")));
					const del = item.createEl("button", { cls: "easypdf-signature-delete clickable-icon", attr: { "aria-label": "Gespeicherte Unterschrift entfernen" } });
					setIcon(del, "x");
					del.addEventListener("click", async (e) => {
						e.stopPropagation();
						s.signatures.splice(idx, 1);
						await this.plugin.saveSettings();
						this.renderParamsBar();
					});
				});
				this.textButton(bar, "plus", "Neue Unterschrift …", () => this.newSignature());
				break;
			}
		}
	}

	private colorInput(parent: HTMLElement, label: string, value: string, param: string, onChange: (v: string) => void): void {
		const field = parent.createEl("label", { cls: "easypdf-field" });
		field.createSpan({ text: label });
		const input = field.createEl("input", { type: "color", attr: { "data-param": param } });
		input.value = value;
		input.addEventListener("input", () => onChange(input.value));
	}

	private rangeInput(
		parent: HTMLElement,
		label: string,
		min: number,
		max: number,
		step: number,
		value: number,
		param: string,
		format: (v: number) => string,
		onChange: (v: number) => void,
	): void {
		const field = parent.createEl("label", { cls: "easypdf-field" });
		field.createSpan({ text: label });
		const input = field.createEl("input", {
			type: "range",
			cls: "slider",
			attr: { min: String(min), max: String(max), step: String(step), "data-param": param },
		});
		input.value = String(value);
		const out = field.createSpan({ cls: "easypdf-value", text: format(value) });
		input.addEventListener("input", () => {
			const v = Number(input.value);
			out.setText(format(v));
			onChange(v);
		});
		(input as HTMLInputElement & { easypdfFormat?: (v: number) => string }).easypdfFormat = format;
	}

	private textButton(parent: HTMLElement, icon: string, text: string, onClick: () => void): void {
		const btn = parent.createEl("button", { cls: "easypdf-text-btn" });
		setIcon(btn.createSpan({ cls: "easypdf-text-btn-icon" }), icon);
		btn.createSpan({ text });
		btn.addEventListener("click", onClick);
	}

	/** Updates the params bar controls when pdf.js reports values (e.g. of a selected annotation). */
	private reflectParam(type: number, value: unknown): void {
		const setRange = (param: string, v: number) => {
			const input = this.paramsBarEl.querySelector<HTMLInputElement>(`input[data-param="${param}"]`);
			if (!input) return;
			input.value = String(v);
			const fmt = (input as HTMLInputElement & { easypdfFormat?: (v: number) => string }).easypdfFormat;
			input.parentElement?.querySelector(".easypdf-value")?.setText(fmt ? fmt(v) : String(v));
		};
		const setColor = (param: string, v: unknown) => {
			const input = this.paramsBarEl.querySelector<HTMLInputElement>(`input[data-param="${param}"]`);
			if (input && typeof v === "string") input.value = v;
		};
		switch (type) {
			case ParamType.FREETEXT_COLOR:
				setColor("freetext-color", value);
				break;
			case ParamType.FREETEXT_SIZE:
				setRange("freetext-size", Number(value));
				break;
			case ParamType.INK_COLOR:
				setColor("ink-color", value);
				break;
			case ParamType.INK_THICKNESS:
				setRange("ink-thickness", Number(value));
				break;
			case ParamType.INK_OPACITY:
				setRange("ink-opacity", Math.round(Number(value) * 100));
				break;
			case ParamType.HIGHLIGHT_THICKNESS:
				setRange("highlight-thickness", Number(value));
				break;
			case ParamType.HIGHLIGHT_COLOR:
				if (typeof value === "string") {
					this.paramsBarEl.querySelectorAll<HTMLElement>(".easypdf-swatch").forEach((sw) => {
						sw.toggleClass("is-active", sw.dataset.color === value.toLowerCase());
					});
				}
				break;
		}
	}

	private async insertImage(file: File): Promise<void> {
		if (!this.pdfViewer?.pdfDocument) return;
		if (this.currentMode() !== EditorType.STAMP) {
			const changed = this.waitForMode(EditorType.STAMP);
			this.pdfViewer.annotationEditorMode = { mode: EditorType.STAMP } as never;
			await changed;
		}
		this.dispatchParam(ParamType.CREATE, { bitmapFile: file });
	}

	private newSignature(): void {
		const s = this.plugin.settings;
		new SignatureModal(this.app, s.signatures.length < MAX_SIGNATURES, async (result) => {
			if (!result) return;
			if (result.save && s.signatures.length < MAX_SIGNATURES) {
				s.signatures.push(result.dataUrl);
				await this.plugin.saveSettings();
				if (this.tool === "signature") this.renderParamsBar();
			}
			await this.insertImage(result.file);
		}).open();
	}

	// ---------------------------------------------------------------------------
	// Saving
	// ---------------------------------------------------------------------------

	private createAutoSaver(): (() => void) & { cancel: () => void } {
		let timer: number | null = null;
		const fn = (() => {
			if (timer !== null) window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				timer = null;
				if (this.dirty && this.plugin.settings.autoSave) void this.save(undefined, true);
			}, this.plugin.settings.autoSaveDelaySeconds * 1000);
		}) as (() => void) & { cancel: () => void };
		fn.cancel = () => {
			if (timer !== null) window.clearTimeout(timer);
			timer = null;
		};
		return fn;
	}

	private markDirty(): void {
		if (!this.pdfDocument) return;
		this.setDirty(true);
		if (this.plugin.settings.autoSave) this.autoSaveDebounced();
	}

	private setDirty(dirty: boolean): void {
		this.dirty = dirty;
		this.saveBtn?.toggleClass("is-dirty", dirty);
		this.saveHeaderAction?.toggleClass("is-dirty", dirty);
		this.contentEl.toggleClass("is-dirty", dirty);
		// Refresh the tab title (shows "●" for unsaved changes).
		(this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.();
		const titleEl = (this as unknown as { titleEl?: HTMLElement }).titleEl;
		titleEl?.setText(this.getDisplayText());
	}

	get hasUnsavedChanges(): boolean {
		return this.dirty;
	}

	/** Writes all annotations into the PDF file (overwrites it, like "Save" in Firefox). */
	async save(file: TFile | null = this.file, silent = false): Promise<void> {
		if (this.saving) {
			await this.saving;
			if (!this.dirty) return;
		}
		const doc = this.pdfDocument;
		if (!doc || !file) return;
		if (!this.dirty) {
			if (!silent) new Notice("easyPDF: Keine Änderungen zu speichern.");
			return;
		}
		this.autoSaveDebounced.cancel();
		this.saving = (async () => {
			try {
				// Commit text that is still being typed / a drawing in progress.
				// When autosaving, don't interrupt the user while they're typing.
				if (!silent) this.uiManager?.endCurrentEditing();
				this.setDirty(false);
				const bytes = await doc.saveDocument();
				this.ownWriteAt = Date.now();
				await this.app.vault.modifyBinary(file, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
				this.ownWriteAt = Date.now();
				if (!silent) new Notice(`„${file.name}“ gespeichert.`);
			} catch (err) {
				console.error("easyPDF: save failed", err);
				this.setDirty(true);
				new Notice(`easyPDF: Speichern fehlgeschlagen – ${String((err as Error)?.message ?? err)}`);
			} finally {
				this.saving = null;
			}
		})();
		await this.saving;
	}

	/** Switches this tab back to Obsidian's normal PDF viewer. */
	async exitEditing(): Promise<void> {
		const file = this.file;
		if (!file) return;
		if (this.dirty) {
			const choice = await new Promise<"save" | "discard" | "cancel">((resolve) =>
				new UnsavedChangesModal(this.app, file.name, resolve).open(),
			);
			if (choice === "cancel") return;
			if (choice === "save") {
				await this.save();
				if (this.dirty) return;
			} else {
				this.discardOnUnload = true;
				this.setDirty(false);
			}
		}
		await this.leaf.setViewState({ type: "pdf", state: { file: file.path }, active: true });
	}

	private showMessage(text: string, isError = false): void {
		this.messageEl.setText(text);
		this.messageEl.toggleClass("is-error", isError);
		this.messageEl.removeClass("easypdf-hidden");
	}

	private hideMessage(): void {
		this.messageEl.addClass("easypdf-hidden");
	}
}
