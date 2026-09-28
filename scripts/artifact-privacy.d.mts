export function configuredSecrets(root: string): string[];
export function privateArtifactPath(path: string): boolean;
export function contentFindings(bytes: Buffer, secrets: string[], home?: string): string[];
export function safeLocation(path: string, secrets: string[]): string;
