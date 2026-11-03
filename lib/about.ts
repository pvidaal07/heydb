import pkg from "../package.json" with { type: "json" };

export const HEYDB_VERSION: string = pkg.version;

export function aboutMessage(): string {
	return `heydb ${HEYDB_VERSION} (v2 in development)`;
}
