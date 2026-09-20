/**
 * Browser configuration.
 *
 * Everything here is public: Vite inlines `import.meta.env.VITE_*` into the
 * bundle, so anything in this file ships to every visitor. Identifiers are fine
 * (a Cognito pool id is not a credential); secrets are not, and none are read
 * here. See `.env.example`.
 */

function env(key: string, fallback = ''): string {
  const value = import.meta.env[key as keyof ImportMetaEnv];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

export const appConfig = {
  name: 'Vyapio',
  tagline: 'Your shop. Your memory. Your AI.',

  /**
   * Empty in development: Vite proxies /api to the local API server, so the
   * client uses the same relative paths locally and behind CloudFront.
   */
  apiUrl: env('VITE_API_URL'),

  cognito: {
    userPoolId: env('VITE_COGNITO_USER_POOL_ID'),
    clientId: env('VITE_COGNITO_CLIENT_ID'),
    region: env('VITE_AWS_REGION', 'ap-south-1'),
  },

  demoMode: env('VITE_DEMO_MODE', 'true') !== 'false',

  storageKeys: {
    tokens: 'vyapio.tokens',
    theme: 'vyapio.theme',
    language: 'vyapio.language',
    queue: 'vyapio.offline.queue',
    lastRoute: 'vyapio.lastRoute',
  },
} as const;

/** Base path for API calls. */
export function apiBase(): string {
  return appConfig.apiUrl || '/api';
}
