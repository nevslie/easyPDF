import { App, PluginSettingTab, Setting } from "obsidian";
import type EasyPdfPlugin from "./main";

export type ZoomDefault = "auto" | "page-width" | "page-fit" | "page-actual";

export interface EasyPdfSettings {
	showEditButton: boolean;
	defaultZoom: ZoomDefault;
	autoSave: boolean;
	autoSaveDelaySeconds: number;
	saveOnTextFieldLeave: boolean;
	saveOnClose: boolean;
	textColor: string;
	textSize: number;
	inkColor: string;
	inkThickness: number;
	inkOpacity: number;
	highlightColor: string;
	highlightThickness: number;
	/** Saved signatures as PNG data URLs (max. 5, like Firefox). */
	signatures: string[];
}

export const DEFAULT_SETTINGS: EasyPdfSettings = {
	showEditButton: true,
	defaultZoom: "auto",
	autoSave: false,
	autoSaveDelaySeconds: 3,
	saveOnTextFieldLeave: true,
	saveOnClose: true,
	textColor: "#000000",
	textSize: 10,
	inkColor: "#000000",
	inkThickness: 1,
	inkOpacity: 1,
	highlightColor: "#FFFF98",
	highlightThickness: 12,
	signatures: [],
};

export const MAX_SIGNATURES = 5;

/** Same palette as Firefox. */
export const HIGHLIGHT_COLORS: Record<string, string> = {
	Gelb: "#FFFF98",
	Grün: "#53FFBC",
	Blau: "#80EBFF",
	Pink: "#FFCBE6",
	Rot: "#FF4F5F",
};

export class EasyPdfSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: EasyPdfPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		containerEl.empty();

		new Setting(containerEl).setName("Allgemein").setHeading();

		new Setting(containerEl)
			.setName("„Bearbeiten“-Knopf in der PDF-Ansicht")
			.setDesc("Zeigt in Obsidians normaler PDF-Ansicht oben rechts einen Stift-Knopf, der die Datei in easyPDF öffnet.")
			.addToggle((t) =>
				t.setValue(s.showEditButton).onChange(async (v) => {
					s.showEditButton = v;
					await save();
					this.plugin.refreshEditButtons();
				}),
			);

		new Setting(containerEl).setName("Standard-Zoom").addDropdown((d) =>
			d
				.addOptions({
					auto: "Automatisch",
					"page-width": "Seitenbreite",
					"page-fit": "Ganze Seite",
					"page-actual": "Originalgröße",
				})
				.setValue(s.defaultZoom)
				.onChange(async (v) => {
					s.defaultZoom = v as ZoomDefault;
					await save();
				}),
		);

		new Setting(containerEl).setName("Speichern").setHeading();

		new Setting(containerEl)
			.setName("Beim Verlassen eines Textfelds speichern")
			.setDesc("Speichert die PDF automatisch, sobald du ein Textfeld verlässt (z. B. daneben klickst oder Esc drückst).")
			.addToggle((t) =>
				t.setValue(s.saveOnTextFieldLeave).onChange(async (v) => {
					s.saveOnTextFieldLeave = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Automatisch speichern")
			.setDesc("Speichert Änderungen kurz nach der letzten Bearbeitung automatisch in die PDF.")
			.addToggle((t) =>
				t.setValue(s.autoSave).onChange(async (v) => {
					s.autoSave = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Verzögerung beim automatischen Speichern")
			.setDesc("Sekunden nach der letzten Änderung.")
			.addSlider((sl) =>
				sl
					.setLimits(1, 30, 1)
					.setValue(s.autoSaveDelaySeconds)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.autoSaveDelaySeconds = v;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Beim Schließen speichern")
			.setDesc("Ungespeicherte Änderungen werden beim Schließen des Tabs automatisch gespeichert statt verworfen.")
			.addToggle((t) =>
				t.setValue(s.saveOnClose).onChange(async (v) => {
					s.saveOnClose = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Standardwerte der Werkzeuge")
			.setDesc("Werden automatisch übernommen, wenn du Farbe, Größe usw. in der Werkzeugleiste änderst.")
			.setHeading();

		new Setting(containerEl).setName("Textfarbe").addColorPicker((c) =>
			c.setValue(s.textColor).onChange(async (v) => {
				s.textColor = v;
				await save();
			}),
		);
		new Setting(containerEl).setName("Schriftgröße").addSlider((sl) =>
			sl
				.setLimits(5, 100, 1)
				.setValue(s.textSize)
				.setDynamicTooltip()
				.onChange(async (v) => {
					s.textSize = v;
					await save();
				}),
		);
		new Setting(containerEl).setName("Stiftfarbe").addColorPicker((c) =>
			c.setValue(s.inkColor).onChange(async (v) => {
				s.inkColor = v;
				await save();
			}),
		);
		new Setting(containerEl).setName("Strichstärke").addSlider((sl) =>
			sl
				.setLimits(1, 20, 1)
				.setValue(s.inkThickness)
				.setDynamicTooltip()
				.onChange(async (v) => {
					s.inkThickness = v;
					await save();
				}),
		);
		new Setting(containerEl).setName("Deckkraft des Stifts (%)").addSlider((sl) =>
			sl
				.setLimits(5, 100, 5)
				.setValue(Math.round(s.inkOpacity * 100))
				.setDynamicTooltip()
				.onChange(async (v) => {
					s.inkOpacity = v / 100;
					await save();
				}),
		);
		new Setting(containerEl).setName("Markierfarbe").addDropdown((d) => {
			for (const [name, hex] of Object.entries(HIGHLIGHT_COLORS)) d.addOption(hex, name);
			d.setValue(s.highlightColor).onChange(async (v) => {
				s.highlightColor = v;
				await save();
			});
		});

		new Setting(containerEl).setName("Unterschriften").setHeading();
		new Setting(containerEl)
			.setName("Gespeicherte Unterschriften")
			.setDesc(`${s.signatures.length} von ${MAX_SIGNATURES} gespeichert.`)
			.addButton((b) =>
				b
					.setButtonText("Alle löschen")
					.setWarning()
					.setDisabled(s.signatures.length === 0)
					.onClick(async () => {
						s.signatures = [];
						await save();
						this.display();
					}),
			);
	}
}
