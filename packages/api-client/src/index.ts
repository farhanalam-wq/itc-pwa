export interface ApiClientOptions {
  baseUrl: string;
  getAccessToken?: () => Promise<string | undefined>;
}

export function createApiClientOptions(baseUrl: string): ApiClientOptions {
  return { baseUrl };
}
