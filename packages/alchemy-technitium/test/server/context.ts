/** What the test server holds before the first test runs (see globalSetup.ts). */
export const ZONES = {
  /** Primary zones the scoped token may view, modify and delete in. */
  primary: ["example.test", "homelab.example.com"],
  /** The reverse zone for 192.0.2.0/24. The scoped token may only view it. */
  reverse: "2.0.192.in-addr.arpa",
  /** A conditional forwarder zone, which the provider must refuse. */
  forwarder: "forward.test",
} as const;
export const SCOPED_USER = "alchemy";

declare module "vitest" {
  export interface ProvidedContext {
    /** The throwaway server's address, an admin token and a token scoped to the test zones. */
    technitium: { url: string; adminToken: string; scopedToken: string };
  }
}
