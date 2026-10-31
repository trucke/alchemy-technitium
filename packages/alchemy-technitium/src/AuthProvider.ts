import { getEnvRedactedRequired, getEnvRequired } from "alchemy/Auth/Env";
import {
  makeStoredAuthProvider,
  storedSecret,
  storedValueText,
  type StoredAuthConfig,
} from "alchemy/Auth/StoredAuthProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

export const TECHNITIUM_AUTH_PROVIDER_NAME = "Technitium";
export type TechnitiumAuthConfig = StoredAuthConfig;
export interface TechnitiumResolvedCredentials {
  readonly type: "token";
  readonly apiToken: Redacted.Redacted<string>;
  /** Web service origin, such as `https://dns.example.com:53443`. */
  readonly apiUrl: string;
  readonly source: { readonly type: TechnitiumAuthConfig["method"] | "env" };
}

const auth = makeStoredAuthProvider<TechnitiumResolvedCredentials>({
  provider: TECHNITIUM_AUTH_PROVIDER_NAME,
  fields: [
    { name: "apiUrl", label: "Technitium web service origin (https://host:53443)" },
    { name: "apiToken", label: "Technitium API token", secret: true },
  ],
  toResolved: (values) => ({
    type: "token",
    apiToken: storedSecret(values.apiToken) ?? Redacted.make(""),
    apiUrl: storedValueText(values.apiUrl) ?? "",
    source: { type: "stored" },
  }),
  readEnvironment: Effect.all({
    apiToken: getEnvRedactedRequired("TECHNITIUM_API_TOKEN"),
    apiUrl: getEnvRequired("TECHNITIUM_API_URL"),
  }).pipe(
    Effect.map((config) => ({
      ...config,
      type: "token" as const,
      source: { type: "env" as const },
    })),
  ),
  environment: [
    { name: "TECHNITIUM_API_TOKEN", required: true, secret: true },
    { name: "TECHNITIUM_API_URL", required: true },
  ],
});

/** Registers the Technitium login for `alchemy profile` and for environment variables in CI. */
export const TechnitiumAuth = auth.layer;
