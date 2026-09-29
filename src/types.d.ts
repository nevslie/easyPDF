declare module "easypdf:worker" {
	const source: string;
	export default source;
}

declare module "easypdf:assets" {
	const assets: Map<string, Uint8Array>;
	export default assets;
}
