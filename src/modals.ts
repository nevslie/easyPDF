import { App, FuzzySuggestModal, Modal, Setting, TFile } from "obsidian";

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"];

const MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	svg: "image/svg+xml",
	avif: "image/avif",
};

export async function vaultImageToFile(app: App, file: TFile): Promise<File> {
	const data = await app.vault.readBinary(file);
	return new File([data], file.name, { type: MIME_BY_EXT[file.extension.toLowerCase()] ?? "application/octet-stream" });
}

/** Lets the user pick an image from the vault. */
export class VaultImageModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private onChoose: (file: TFile) => void,
	) {
		super(app);
		this.setPlaceholder("Bild aus dem Vault auswählen …");
	}

	getItems(): TFile[] {
		return this.app.vault.getFiles().filter((f) => IMAGE_EXTENSIONS.includes(f.extension.toLowerCase()));
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onChoose(file);
	}
}

/** Opens the OS file picker for an image. */
export function pickImageFromComputer(): Promise<File | null> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = IMAGE_EXTENSIONS.map((e) => `.${e}`).join(",");
		input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
		input.addEventListener("cancel", () => resolve(null), { once: true });
		input.click();
	});
}

export type UnsavedChoice = "save" | "discard" | "cancel";

/** "Save changes?" dialog, like Firefox asks before leaving an edited PDF. */
export class UnsavedChangesModal extends Modal {
	private choice: UnsavedChoice = "cancel";

	constructor(
		app: App,
		private fileName: string,
		private onDone: (choice: UnsavedChoice) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Ungespeicherte Änderungen");
		this.contentEl.createEl("p", {
			text: `„${this.fileName}“ enthält ungespeicherte Änderungen. Möchtest du sie speichern?`,
		});
		new Setting(this.contentEl)
			.addButton((b) =>
				b.setButtonText("Abbrechen").onClick(() => {
					this.choice = "cancel";
					this.close();
				}),
			)
			.addButton((b) =>
				b
					.setButtonText("Verwerfen")
					.setWarning()
					.onClick(() => {
						this.choice = "discard";
						this.close();
					}),
			)
			.addButton((b) =>
				b
					.setButtonText("Speichern")
					.setCta()
					.onClick(() => {
						this.choice = "save";
						this.close();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
		this.onDone(this.choice);
	}
}

export interface SignatureResult {
	file: File;
	dataUrl: string;
	save: boolean;
}

/**
 * Signature pad modeled on Firefox's "Add signature" dialog:
 * draw with mouse/pen or type your name, optionally keep it for later.
 */
export class SignatureModal extends Modal {
	private canvas!: HTMLCanvasElement;
	private ctx!: CanvasRenderingContext2D;
	private mode: "draw" | "type" = "draw";
	private typed = "";
	private hasStrokes = false;
	private thickness = 3;
	private saveSignature = true;
	private done = false;

	constructor(
		app: App,
		private canSave: boolean,
		private onDone: (result: SignatureResult | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Unterschrift hinzufügen");
		this.modalEl.addClass("easypdf-signature-modal");
		const { contentEl } = this;

		const tabs = contentEl.createDiv({ cls: "easypdf-signature-tabs" });
		const drawTab = tabs.createEl("button", { text: "Zeichnen" });
		const typeTab = tabs.createEl("button", { text: "Tippen" });

		const drawArea = contentEl.createDiv({ cls: "easypdf-signature-area" });
		this.canvas = drawArea.createEl("canvas", { cls: "easypdf-signature-canvas" });
		this.canvas.width = 1200;
		this.canvas.height = 400;
		this.ctx = this.canvas.getContext("2d")!;
		const placeholder = drawArea.createDiv({ cls: "easypdf-signature-placeholder", text: "Hier unterschreiben" });

		const typeArea = contentEl.createDiv({ cls: "easypdf-signature-area easypdf-hidden" });
		const input = typeArea.createEl("input", {
			type: "text",
			cls: "easypdf-signature-input",
			attr: { placeholder: "Name eingeben" },
		});
		input.addEventListener("input", () => {
			this.typed = input.value;
		});

		const thicknessSetting = new Setting(contentEl).setName("Strichstärke").addSlider((s) =>
			s
				.setLimits(1, 10, 1)
				.setValue(this.thickness)
				.setDynamicTooltip()
				.onChange((v) => (this.thickness = v)),
		);

		const setMode = (mode: "draw" | "type") => {
			this.mode = mode;
			drawTab.toggleClass("is-active", mode === "draw");
			typeTab.toggleClass("is-active", mode === "type");
			drawArea.toggleClass("easypdf-hidden", mode !== "draw");
			typeArea.toggleClass("easypdf-hidden", mode !== "type");
			thicknessSetting.settingEl.toggleClass("easypdf-hidden", mode !== "draw");
			if (mode === "type") input.focus();
		};
		drawTab.addEventListener("click", () => setMode("draw"));
		typeTab.addEventListener("click", () => setMode("type"));
		setMode("draw");

		this.setupDrawing(placeholder);

		if (this.canSave) {
			new Setting(contentEl).setName("Unterschrift für später speichern").addToggle((t) =>
				t.setValue(this.saveSignature).onChange((v) => (this.saveSignature = v)),
			);
		} else {
			this.saveSignature = false;
		}

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("Leeren").onClick(() => {
					this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
					this.hasStrokes = false;
					placeholder.removeClass("easypdf-hidden");
					input.value = "";
					this.typed = "";
				}),
			)
			.addButton((b) => b.setButtonText("Abbrechen").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Hinzufügen")
					.setCta()
					.onClick(() => void this.finish()),
			);
	}

	private setupDrawing(placeholder: HTMLElement): void {
		const { canvas, ctx } = this;
		let drawing = false;
		let last: { x: number; y: number } | null = null;
		const pos = (e: PointerEvent) => {
			const r = canvas.getBoundingClientRect();
			return {
				x: ((e.clientX - r.left) / r.width) * canvas.width,
				y: ((e.clientY - r.top) / r.height) * canvas.height,
			};
		};
		canvas.addEventListener("pointerdown", (e) => {
			drawing = true;
			canvas.setPointerCapture(e.pointerId);
			last = pos(e);
			placeholder.addClass("easypdf-hidden");
			ctx.beginPath();
			ctx.arc(last.x, last.y, this.thickness, 0, Math.PI * 2);
			ctx.fillStyle = "#000";
			ctx.fill();
			this.hasStrokes = true;
		});
		canvas.addEventListener("pointermove", (e) => {
			if (!drawing || !last) return;
			const p = pos(e);
			ctx.strokeStyle = "#000";
			ctx.lineWidth = this.thickness * 2;
			ctx.lineCap = "round";
			ctx.lineJoin = "round";
			ctx.beginPath();
			ctx.moveTo(last.x, last.y);
			ctx.lineTo(p.x, p.y);
			ctx.stroke();
			last = p;
		});
		const stop = () => {
			drawing = false;
			last = null;
		};
		canvas.addEventListener("pointerup", stop);
		canvas.addEventListener("pointercancel", stop);
	}

	/** Renders the typed name onto a canvas in a handwriting-like font. */
	private renderTyped(): HTMLCanvasElement | null {
		const text = this.typed.trim();
		if (!text) return null;
		const c = document.createElement("canvas");
		const ctx = c.getContext("2d")!;
		const font = `italic 120px "Segoe Script", "Brush Script MT", "Apple Chancery", cursive`;
		ctx.font = font;
		const width = Math.ceil(ctx.measureText(text).width) + 40;
		c.width = width;
		c.height = 180;
		ctx.font = font;
		ctx.fillStyle = "#000";
		ctx.textBaseline = "middle";
		ctx.fillText(text, 20, 90);
		return c;
	}

	private async finish(): Promise<void> {
		const source = this.mode === "draw" ? (this.hasStrokes ? this.canvas : null) : this.renderTyped();
		if (!source) return;
		const cropped = cropToContent(source);
		const blob = await new Promise<Blob | null>((r) => cropped.toBlob(r, "image/png"));
		if (!blob) return;
		const dataUrl = cropped.toDataURL("image/png");
		this.done = true;
		this.close();
		this.onDone({ file: new File([blob], "Unterschrift.png", { type: "image/png" }), dataUrl, save: this.saveSignature });
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.done) this.onDone(null);
	}
}

/** Trims transparent borders so the stamp is exactly as big as the signature. */
function cropToContent(src: HTMLCanvasElement): HTMLCanvasElement {
	const ctx = src.getContext("2d")!;
	const { width, height } = src;
	const data = ctx.getImageData(0, 0, width, height).data;
	let minX = width,
		minY = height,
		maxX = -1,
		maxY = -1;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (data[(y * width + x) * 4 + 3] > 0) {
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
		}
	}
	if (maxX < 0) return src;
	const pad = 8;
	minX = Math.max(0, minX - pad);
	minY = Math.max(0, minY - pad);
	maxX = Math.min(width - 1, maxX + pad);
	maxY = Math.min(height - 1, maxY + pad);
	const out = document.createElement("canvas");
	out.width = maxX - minX + 1;
	out.height = maxY - minY + 1;
	out.getContext("2d")!.drawImage(src, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
	return out;
}

export async function dataUrlToFile(dataUrl: string, name: string): Promise<File> {
	const blob = await (await fetch(dataUrl)).blob();
	return new File([blob], name, { type: blob.type || "image/png" });
}
