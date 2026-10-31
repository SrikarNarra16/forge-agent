/** Builds the TrueForge capabilities URL used for health checks, tolerating trailing slashes in the setting. */
export function capabilitiesUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}/api/v1/capabilities`;
}
