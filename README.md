# easyPDF für Obsidian

PDFs direkt in Obsidian bearbeiten, so wie im PDF-Editor von Firefox:

- **Text:** Textfelder an beliebiger Stelle einfügen. Farbe und Größe lassen sich einstellen, die Felder kann man verschieben.
- **Zeichnen:** Freihand mit Maus, Touchpad oder Stift über die ganze Seite zeichnen. Farbe, Strichstärke und Deckkraft sind einstellbar.
- **Markieren:** Text markieren oder frei über die Seite markieren, mit den Farben Gelb, Grün, Blau, Pink und Rot.
- **Bilder:** Bilder aus dem Vault oder vom Computer einfügen, verschieben und skalieren.
- **Unterschriften:** Unterschrift zeichnen oder tippen und für später speichern (bis zu 5).
- **Weitere Funktionen:** Rückgängig und Wiederholen, Löschen, Suchen, Zoom und Seitennavigation.

easyPDF verwendet **pdf.js**, dieselbe Engine wie Firefox. Alles, was du hinzufügst, wird als **echte PDF-Annotation** gespeichert. Du kannst es später weiter bearbeiten, in easyPDF, Firefox oder anderen PDF-Programmen.

## Benutzung

1. Öffne eine PDF ganz normal in Obsidian.
2. Klicke oben rechts auf das **Stift-Symbol** („Mit easyPDF bearbeiten“). Alternativ geht das per Rechtsklick auf die Datei → **Mit easyPDF bearbeiten** oder über die Befehlspalette → **easyPDF: Aktuelle PDF bearbeiten**.
3. Wähle in der Werkzeugleiste ein Werkzeug. Nochmal klicken schaltet es wieder aus.
4. Speichere mit **Strg+S** (Mac: Cmd+S) oder über das Speichern-Symbol. Dabei wird die Originaldatei überschrieben.
5. Mit dem Flammen-Symbol neben „Speichern“ (**Annotationen einbrennen**) entsteht eine Kopie „Name (eingebrannt).pdf“. Darin sind alle Anmerkungen fest in die Seiten eingezeichnet, Textfelder werden zu normalem Text der Seite. Die Originaldatei bleibt unverändert. Links und Formularfelder bleiben erhalten.
6. Mit dem Buch-Symbol oben rechts (**Bearbeiten beenden**) geht es zurück zur normalen PDF-Ansicht.

Um vorhandene Anmerkungen zu bearbeiten, wählst du das passende Werkzeug und klickst die Anmerkung an. Mit **Entf** löschst du sie, mit den Pfeiltasten verschiebst du sie.

### Tastenkürzel

| Kürzel | Aktion |
| --- | --- |
| Strg+S | Speichern |
| Strg+F | Im Dokument suchen |
| Strg+Z / Strg+Umschalt+Z | Rückgängig / Wiederholen |
| Entf | Ausgewählte Anmerkung löschen |
| Strg+A | Alle Anmerkungen auswählen (im Bearbeitungsmodus) |

Über die Befehlspalette kannst du außerdem jedem Werkzeug ein eigenes Tastenkürzel geben (*Einstellungen → Tastenkürzel → easyPDF*).

## Einstellungen

- „Bearbeiten“-Knopf in Obsidians PDF-Ansicht ein- oder ausblenden
- Standard-Zoom
- Beim Verlassen eines Textfelds automatisch speichern (standardmäßig an)
- Automatisch speichern, mit einstellbarer Verzögerung
- Beim Schließen des Tabs automatisch speichern (standardmäßig an)
- Standardfarben und -größen der Werkzeuge. Die Werte aus der Werkzeugleiste werden automatisch übernommen.
- Gespeicherte Unterschriften verwalten

## Installation (manuell)

1. `npm install` und danach `npm run build` ausführen. Dabei entstehen `main.js` und `styles.css`.
2. Im Vault den Ordner `.obsidian/plugins/easypdf/` anlegen.
3. `main.js`, `styles.css` und `manifest.json` dort hineinkopieren.
4. In Obsidian unter *Einstellungen → Community-Plugins* „easyPDF“ aktivieren.

Für die Entwicklung startet `npm run dev` einen Watch-Build.

## Technik

- `src/pdfjs.ts`: bindet pdf.js ein. Worker, Standardschriften und WASM-Decoder stecken im Bundle, das Plugin braucht keinen Netzwerkzugriff.
- `src/PdfEditorView.ts`: die Editor-Ansicht mit Werkzeugleiste, Speichern und Suche.
- `src/flatten.ts`: brennt Annotationen ein (zeichnet ihre Darstellung mit pdf-lib in den Seiteninhalt).
- `src/modals.ts`: Dialoge für Unterschrift, Bildauswahl und „Ungespeicherte Änderungen“.
- `esbuild.config.mjs`: baut das Plugin. pdf.js wird dabei so umgeschrieben, dass es nicht mit Obsidians eigenem pdf.js kollidiert. Außerdem wird das CSS von pdf.js auf die easyPDF-Ansicht beschränkt.

Die erste Version läuft nur auf dem Desktop.

## Drittanbieter

Das Plugin-Bundle enthält pdf.js (Apache-2.0, © Mozilla Foundation), pdf-lib (MIT) sowie Schriften von Foxit und Liberation (siehe die jeweiligen Lizenzen im Paket `pdfjs-dist`).
