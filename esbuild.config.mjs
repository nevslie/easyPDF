import esbuild from "esbuild";
import process from "process";
import fs from "fs";
import path from "path";
import { builtinModules } from "module";
import { pathToFileURL } from "url";
import postcss from "postcss";
import postcssNesting from "postcss-nesting";

const prod = process.argv[2] === "production";
const PDFJS_DIR = path.resolve("node_modules/pdfjs-dist");
const CSS_SCOPE = ".easypdf-view";

/**
 * pdf.js publishes itself as `globalThis.pdfjsLib` and the viewer components
 * read the library back from that global. Obsidian ships its own (different)
 * pdf.js version under the same global, so we rewrite both files to use a
 * plain module import instead and never touch the globals.
 *
 * We use the "legacy" build: pdf.js 6 relies on very recent JS features
 * (e.g. Map#getOrInsertComputed) that Obsidian's Electron may not have yet;
 * the legacy build ships the necessary polyfills.
 */
export const pdfjsIsolationPlugin = {
	name: "pdfjs-isolation",
	setup(build) {
		build.onLoad({ filter: /pdfjs-dist[\\/]legacy[\\/]build[\\/]pdf\.mjs$/ }, async (args) => {
			let src = await fs.promises.readFile(args.path, "utf8");
			src = replaceOnce(src, "globalThis.pdfjsLib = {", "const __easypdfUnusedLib = {");
			// The editors read a few CSS variables (e.g. --freetext-padding) from :root.
			// Our copy of the viewer CSS is scoped to `.easypdf-view`, so read them there.
			src = replaceAll(
				src,
				"getComputedStyle(document.documentElement)",
				'getComputedStyle(document.querySelector(".easypdf-view") || document.documentElement)',
				2,
			);
			return { contents: src, loader: "js" };
		});
		build.onLoad({ filter: /pdfjs-dist[\\/]legacy[\\/]web[\\/]pdf_viewer\.mjs$/ }, async (args) => {
			let src = await fs.promises.readFile(args.path, "utf8");
			src = replaceOnce(src, "} = globalThis.pdfjsLib;", "} = __easypdfLib;");
			src = replaceOnce(src, "globalThis.pdfjsViewer = {", "const __easypdfUnusedViewer = {");
			src = `import * as __easypdfLib from "pdfjs-dist/legacy/build/pdf.mjs";\n${src}`;
			return { contents: src, loader: "js", resolveDir: path.dirname(args.path) };
		});
	},
};

function replaceAll(src, search, replacement, expectedCount) {
	const count = src.split(search).length - 1;
	if (count !== expectedCount) {
		throw new Error(`pdfjs-isolation: expected ${expectedCount} occurrences of "${search}", found ${count}`);
	}
	return src.split(search).join(replacement);
}

function replaceOnce(src, search, replacement) {
	const idx = src.indexOf(search);
	if (idx === -1 || src.indexOf(search, idx + 1) !== -1) {
		throw new Error(`pdfjs-isolation: expected exactly one occurrence of "${search}"`);
	}
	return src.replace(search, replacement);
}

/**
 * Virtual modules:
 *  - `easypdf:worker`  -> the pdf.js worker source as a string (started from a Blob URL)
 *  - `easypdf:assets`  -> standard fonts + wasm decoders as Uint8Arrays, served to pdf.js
 *                         through a custom BinaryDataFactory (no network/file access needed)
 */
export const virtualModulesPlugin = {
	name: "easypdf-virtual",
	setup(build) {
		build.onResolve({ filter: /^easypdf:(worker|assets)$/ }, (args) => ({
			path: args.path,
			namespace: "easypdf-virtual",
		}));
		build.onLoad({ filter: /^easypdf:worker$/, namespace: "easypdf-virtual" }, async () => {
			const src = await fs.promises.readFile(path.join(PDFJS_DIR, "legacy/build/pdf.worker.min.mjs"), "utf8");
			return { contents: `export default ${JSON.stringify(src)};`, loader: "js" };
		});
		build.onLoad({ filter: /^easypdf:assets$/, namespace: "easypdf-virtual" }, async () => {
			const groups = {
				standardFontDataUrl: {
					dir: "standard_fonts",
					files: fs
						.readdirSync(path.join(PDFJS_DIR, "standard_fonts"))
						.filter((f) => /\.(pfb|ttf)$/.test(f)),
				},
				wasmUrl: {
					dir: "wasm",
					files: ["jbig2.wasm", "openjpeg.wasm", "qcms_bg.wasm"],
				},
			};
			const imports = [];
			const entries = [];
			let i = 0;
			for (const [kind, { dir, files }] of Object.entries(groups)) {
				for (const file of files) {
					const abs = path.join(PDFJS_DIR, dir, file);
					imports.push(`import a${i} from ${JSON.stringify(abs)};`);
					entries.push(`[${JSON.stringify(`${kind}/${file}`)}, a${i}]`);
					i++;
				}
			}
			return {
				contents: `${imports.join("\n")}\nexport default new Map([${entries.join(",")}]);`,
				loader: "js",
				resolveDir: PDFJS_DIR,
			};
		});
	},
};

/** Builds styles.css: pdf.js viewer CSS (flattened + scoped to our view) + own styles. */
export async function buildCss() {
	const viewerCssPath = path.join(PDFJS_DIR, "legacy/web/pdf_viewer.css");
	const viewerCss = await fs.promises.readFile(viewerCssPath, "utf8");
	const inlineImages = {
		postcssPlugin: "easypdf-inline-images",
		Declaration(decl) {
			if (!decl.value.includes("url(")) return;
			decl.value = decl.value.replace(/url\((['"]?)(images\/[^'")]+)\1\)/g, (_m, _q, rel) => {
				const file = path.join(path.dirname(viewerCssPath), rel);
				const data = fs.readFileSync(file);
				const mime = rel.endsWith(".svg") ? "image/svg+xml" : rel.endsWith(".png") ? "image/png" : "application/octet-stream";
				return `url("data:${mime};base64,${data.toString("base64")}")`;
			});
		},
	};
	const scope = {
		postcssPlugin: "easypdf-scope",
		OnceExit(root) {
			root.walkRules((rule) => {
				const parent = rule.parent;
				if (parent?.type === "atrule" && /keyframes$/i.test(parent.name)) return;
				rule.selectors = rule.selectors.map((sel) => {
					const s = sel.trim();
					if (s === ":root" || s === "html" || s === "body" || s === "*") {
						return s === "*" ? `${CSS_SCOPE} *` : CSS_SCOPE;
					}
					if (s.startsWith(":root")) return CSS_SCOPE + s.slice(":root".length);
					if (/^(html|body)\b/.test(s)) return s.replace(/^(html|body)/, CSS_SCOPE);
					return `${CSS_SCOPE} ${s}`;
				});
			});
		},
	};
	const scoped = await postcss([postcssNesting({ edition: "2024-02" }), inlineImages, scope]).process(viewerCss, {
		from: viewerCssPath,
	});
	const own = await fs.promises.readFile("src/styles.css", "utf8");
	const header = "/* easyPDF – generated file, edit src/styles.css instead. Contains pdf.js viewer styles (Apache-2.0). */\n";
	await fs.promises.writeFile("styles.css", `${header}${scoped.css}\n\n/* ---- easyPDF ---- */\n${own}`);
}

async function main() {
const context = await esbuild.context({
	banner: {
		js: "/* easyPDF – generated bundle. Includes pdf.js (Apache-2.0, Mozilla). */",
	},
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtinModules,
		...builtinModules.map((m) => `node:${m}`),
	],
	loader: {
		".pfb": "binary",
		".ttf": "binary",
		".wasm": "binary",
	},
	plugins: [pdfjsIsolationPlugin, virtualModulesPlugin],
	format: "cjs",
	target: "es2022",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	minify: prod,
	outfile: "main.js",
	logOverride: {
		"empty-import-meta": "silent",
	},
});

await buildCss();

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	fs.watch("src/styles.css", () => buildCss().catch(console.error));
	await context.watch();
}
}

export const assetLoaders = {
	".pfb": "binary",
	".ttf": "binary",
	".wasm": "binary",
};

// Only build when run directly (the plugins above are reused by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	await main();
}
