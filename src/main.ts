import { FileView, Menu, Plugin, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import { PdfEditorView, VIEW_TYPE_EASYPDF } from "./PdfEditorView";
import { DEFAULT_SETTINGS, EasyPdfSettingTab, EasyPdfSettings } from "./settings";
import { destroyWorker } from "./pdfjs";

/** View type of Obsidian's built-in PDF viewer. */
const NATIVE_PDF_VIEW = "pdf";

export default class EasyPdfPlugin extends Plugin {
	declare settings: EasyPdfSettings;
	/** "Edit" buttons we added to native PDF views. */
	private editButtons = new Map<FileView, HTMLElement>();

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_EASYPDF, (leaf) => new PdfEditorView(leaf, this));
		this.addSettingTab(new EasyPdfSettingTab(this.app, this));

		this.addRibbonIcon("file-pen-line", "Aktuelle PDF mit easyPDF bearbeiten", () => {
			const file = this.app.workspace.getActiveFile();
			if (isPdf(file)) void this.openEditor(file);
		});

		this.addCommand({
			id: "edit-current-pdf",
			name: "Aktuelle PDF bearbeiten",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!isPdf(file) || this.getActiveEditor()) return false;
				if (!checking) void this.openEditor(file);
				return true;
			},
		});

		this.addCommand({
			id: "save-pdf",
			name: "PDF speichern",
			checkCallback: (checking) => {
				const view = this.getActiveEditor();
				if (!view) return false;
				if (!checking) void view.save();
				return true;
			},
		});

		this.addCommand({
			id: "exit-editing",
			name: "Bearbeiten beenden (normale PDF-Ansicht)",
			checkCallback: (checking) => {
				const view = this.getActiveEditor();
				if (!view) return false;
				if (!checking) void view.exitEditing();
				return true;
			},
		});

		const toolCommands: [string, string, Parameters<PdfEditorView["selectTool"]>[0]][] = [
			["tool-text", "Werkzeug: Text", "freetext"],
			["tool-draw", "Werkzeug: Zeichnen", "ink"],
			["tool-highlight", "Werkzeug: Markieren", "highlight"],
			["tool-image", "Werkzeug: Bild", "stamp"],
			["tool-signature", "Werkzeug: Unterschrift", "signature"],
			["tool-none", "Werkzeug: Keins (nur ansehen)", "none"],
		];
		for (const [id, name, tool] of toolCommands) {
			this.addCommand({
				id,
				name,
				checkCallback: (checking) => {
					const view = this.getActiveEditor();
					if (!view) return false;
					if (!checking) void view.selectTool(tool);
					return true;
				},
			});
		}

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile, _source: string, leaf?: WorkspaceLeaf) => {
				if (!isPdf(file)) return;
				menu.addItem((item) =>
					item
						.setTitle("Mit easyPDF bearbeiten")
						.setIcon("file-pen-line")
						.setSection("open")
						.onClick(() => {
							const target = leaf?.view.getViewType() === NATIVE_PDF_VIEW ? leaf : undefined;
							void this.openEditor(file, target);
						}),
				);
			}),
		);

		// Save pending edits when Obsidian quits.
		this.registerEvent(
			this.app.workspace.on("quit", (tasks) => {
				for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_EASYPDF)) {
					const view = leaf.view;
					if (view instanceof PdfEditorView && view.hasUnsavedChanges && this.settings.saveOnClose) {
						tasks.add(() => view.save(view.file, true));
					}
				}
			}),
		);

		this.app.workspace.onLayoutReady(() => this.refreshEditButtons());
		this.registerEvent(this.app.workspace.on("layout-change", () => this.refreshEditButtons()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshEditButtons()));
	}

	onunload(): void {
		for (const el of this.editButtons.values()) el.remove();
		this.editButtons.clear();
		destroyWorker();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.settings.signatures = [...(this.settings.signatures ?? [])];
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private getActiveEditor(): PdfEditorView | null {
		return this.app.workspace.getActiveViewOfType(PdfEditorView);
	}

	/**
	 * Opens the PDF in the editor. Replaces the given (native PDF) leaf, otherwise
	 * reuses a leaf already showing this file, otherwise opens a new tab.
	 */
	async openEditor(file: TFile, leaf?: WorkspaceLeaf): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace
			.getLeavesOfType(VIEW_TYPE_EASYPDF)
			.find((l) => (l.view as PdfEditorView).file?.path === file.path);
		if (existing) {
			workspace.setActiveLeaf(existing, { focus: true });
			return;
		}
		let target = leaf;
		if (!target) {
			const active = workspace.getActiveViewOfType(FileView);
			target =
				active?.getViewType() === NATIVE_PDF_VIEW && active.file?.path === file.path
					? active.leaf
					: workspace.getLeaf(false);
		}
		await target.setViewState({ type: VIEW_TYPE_EASYPDF, state: { file: file.path }, active: true });
		workspace.setActiveLeaf(target, { focus: true });
	}

	/** Adds an "Edit" (pencil) button to the header of every native PDF view. */
	refreshEditButtons(): void {
		const nativeViews = new Set<FileView>();
		if (this.settings.showEditButton) {
			for (const leaf of this.app.workspace.getLeavesOfType(NATIVE_PDF_VIEW)) {
				const view = leaf.view;
				if (!(view instanceof FileView)) continue;
				nativeViews.add(view);
				if (this.editButtons.has(view)) continue;
				const btn = view.addAction("file-pen-line", "Mit easyPDF bearbeiten", () => {
					if (isPdf(view.file)) void this.openEditor(view.file, view.leaf);
				});
				btn.addClass("easypdf-edit-action");
				this.editButtons.set(view, btn);
			}
		}
		for (const [view, btn] of this.editButtons) {
			if (!nativeViews.has(view)) {
				btn.remove();
				this.editButtons.delete(view);
			}
		}
	}
}

function isPdf(file: TAbstractFile | null | undefined): file is TFile {
	return file instanceof TFile && file.extension.toLowerCase() === "pdf";
}
