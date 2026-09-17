import * as path from "node:path";

export function normalizeVaultPath(vaultPath: string, platform = process.platform): string {
  const value = vaultPath.trim();
  if (!value) return "";
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const normalized = pathApi.normalize(pathApi.resolve(value));
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function repositoryUrlForVault(repositoryUrlByVault: Record<string, string> | undefined, vaultPath: string, platform = process.platform): string {
  const key = normalizeVaultPath(vaultPath, platform);
  return key ? repositoryUrlByVault?.[key]?.trim() ?? "" : "";
}

export function setRepositoryUrlForVault(repositoryUrlByVault: Record<string, string>, vaultPath: string, value: string, platform = process.platform): void {
  const key = normalizeVaultPath(vaultPath, platform);
  if (!key) return;
  const next = value.trim();
  if (next) repositoryUrlByVault[key] = next;
  else delete repositoryUrlByVault[key];
}
