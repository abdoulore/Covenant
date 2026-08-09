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
  /**
   * True when the app is served from a different origin than this API, which is the split
   * deployment: a static bundle on one host, the write API on a host that can run a persistent
   * process. It changes two things that must move together, so it is derived once here rather than
   * decided separately in two places.
   */
  crossOrigin: boolean;
  /** SameSite policy for the session cookie. See crossOrigin. */
  sameSite: "Strict" | "None";
}

export class ApiConfigError extends Error {}

const DEV_ORIGIN = "http://localhost:5173"; // Vite's default dev origin

/**
 * Build the API config from an environment map. Throws ApiConfigError in deployed mode when the
 * operator secret or CORS origin is missing, so the process cannot start unsafe.
 */
export function loadApiConfig(env: Record<string, string | undefined>): ApiConfig {
  const devMode = env.COVENANT_ENV === "dev" || env.COVENANT_ENV === "development";
  /**
   * PORT first, because that is what a container platform assigns and the process must bind to it
   * or the deploy never becomes reachable. API_PORT stays as the local override, and the literal is
   * the last resort.
   */
  const port = Number(env.PORT ?? env.API_PORT ?? 4320);

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

  /**
   * A pinned CORS origin that is not this API's own origin means a split deployment, and a
   * SameSite=Strict cookie is simply never sent on a cross-site request: every write would 401 with
   * no clue why. COVENANT_SAME_ORIGIN=true forces the stricter cookie back on when the app and the
   * API are served from one origin behind a proxy.
   *
   * SameSite=None gives up the browser's own CSRF protection, so the write routes require a
   * matching Origin header instead. The two always change together, which is why this is one
   * derived flag rather than two independent settings.
   */
  const sameOriginDeclared = env.COVENANT_SAME_ORIGIN === "true";
  const crossOrigin = !devMode && !sameOriginDeclared && corsOrigin !== "";

  return {
    port,
    corsOrigin,
    operatorSecret,
    devMode,
    secureCookies: !devMode,
    crossOrigin,
    sameSite: crossOrigin ? "None" : "Strict",
  };
}
