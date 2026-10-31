import { Credentials, normalizeApiUrl } from "@distilled.cloud/technitium/credentials";
import {
  deferUntilFirstUse,
  orDieCredentialsUnavailable,
  resolveProviderConfig,
} from "alchemy/Auth/Resolve";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  TECHNITIUM_AUTH_PROVIDER_NAME,
  type TechnitiumAuthConfig,
  type TechnitiumResolvedCredentials,
} from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  fromApiToken,
} from "@distilled.cloud/technitium/credentials";

/**
 * The SDK's `Credentials` from the Alchemy login: `TECHNITIUM_API_TOKEN` and
 * `TECHNITIUM_API_URL` when set, otherwise the selected profile. Resolved on first use, so
 * building the layer never needs a configured login.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const resolve = yield* resolveProviderConfig<
        TechnitiumAuthConfig,
        TechnitiumResolvedCredentials
      >(TECHNITIUM_AUTH_PROVIDER_NAME).pipe(
        Effect.flatMap(({ resolve }) => resolve),
        Effect.flatMap(({ apiToken, apiUrl }) =>
          Effect.map(normalizeApiUrl(apiUrl), (origin) => ({ apiToken, apiUrl: origin })),
        ),
        deferUntilFirstUse,
      );
      return yield* resolve.pipe(
        orDieCredentialsUnavailable(TECHNITIUM_AUTH_PROVIDER_NAME),
        Effect.cached,
      );
    }),
  );
