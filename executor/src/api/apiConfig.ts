/**
 * API configuration and boot-safety (Frontend Part B). See docs/DECISIONS.md D12.
 *
 * The one hard rule: in a deployed environment the API refuses to start without an operator secret
 * and a pinned CORS origin. A write-capable API that boots wide open is the failure this guards
 * against. In an explicit local-dev environment the same values are allowed to fall back, so a
 * developer can run it, but that path is opt-in and never the default.
 *
 * loadApiConfig is pure over its `env` argument, so boot-safety is unit-tested without a process.
 */

export interface ApiConfig {
  port: number;
  /** The single allowed browser origin for CORS. Never a wildcard: the session cookie must travel. */
  corsOrigin: string;
  /** The operator secret, compared in constant time on login. Never logged, never returned. */
  operatorSecret: string;
  /** True in an explicit local-dev run, which relaxes the deployed-mode requirements. */
  devMode: boolean;
  /** Secure cookie flag: on in deployed mode (HTTPS), off in local dev (HTTP). */
  secureCookies: boolean;
}

export class ApiConfigError extends Error {}

const DEV_ORIGIN = "http://localhost:5173"; // Vite's default dev origin

/**
 * Build the API config from an environment map. Throws ApiConfigError in deployed mode when the
 * operator secret or CORS origin is missing, so the process cannot start unsafe.
 */
export function loadApiConfig(env: Record<string, string | undefined>): ApiConfig {
  const devMode = env.COVENANT_ENV === "dev" || env.COVENANT_ENV === "development";
  const port = Number(env.API_PORT ?? 4320);

  const operatorSecret = env.OPERATOR_SECRET ?? "";
  const corsOrigin = env.COVENANT_CORS_ORIGIN ?? (devMode ? DEV_ORIGIN : "");

  if (!devMode) {
    if (!operatorSecret) {
      throw new ApiConfigError(
        "OPERATOR_SECRET is required to start the API in a deployed environment. " +
          "Set it, or set COVENANT_ENV=dev for a local run.",
      );
    }
    if (!corsOrigin) {
      throw new ApiConfigError(
        "COVENANT_CORS_ORIGIN is required to start the API in a deployed environment. " +
          "Pin the single browser origin, or set COVENANT_ENV=dev for a local run.",
      );
    }
  }

  if (devMode && !operatorSecret) {
    // Allowed, but make the weakening explicit rather than silent.
    // eslint-disable-next-line no-console
    console.warn("[api] COVENANT_ENV=dev and OPERATOR_SECRET unset: write routes are open. Local use only.");
  }

  return { port, corsOrigin, operatorSecret, devMode, secureCookies: !devMode };
}
