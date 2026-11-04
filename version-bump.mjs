import { readFileSync, writeFileSync } from "fs";
import process from "process";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
	console.error("npm_package_version is not set; run through an npm version script.");
	process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
if (manifest.version !== targetVersion) {
	manifest.version = targetVersion;
	writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");
}

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
if (!versions[targetVersion]) {
	const minAppVersion = manifest.minAppVersion || "1.0.0";
	versions[targetVersion] = minAppVersion;
	const sorted = Object.fromEntries(
		Object.entries(versions).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
	);
	writeFileSync("versions.json", JSON.stringify(sorted, null, "\t") + "\n");
}
