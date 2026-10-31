import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { TechnitiumAuth } from "./AuthProvider.ts";
import { fromAuthProvider } from "./Credentials.ts";
import { Record, RecordProvider } from "./Record.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("Technitium") {}

/**
 * The Record provider with the Technitium login: `TECHNITIUM_API_TOKEN` and
 * `TECHNITIUM_API_URL` when set, otherwise the selected Alchemy profile. The credentials and the
 * HTTP client stay in the stack's context because the engine runs lifecycle operations there.
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Record])).pipe(
    Layer.provide(RecordProvider()),
    Layer.provideMerge(fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(TechnitiumAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
