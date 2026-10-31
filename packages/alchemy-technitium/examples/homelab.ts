import * as Alchemy from "alchemy";
import * as Technitium from "@alchemy.run/technitium";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "Homelab",
  { providers: Technitium.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const nas = yield* Technitium.Record("nas", {
      zone: "homelab.example.com",
      name: "nas.homelab.example.com",
      type: "A",
      address: "192.0.2.20",
      ttl: 300,
      comment: "NAS",
    });
    yield* Technitium.Record("files", {
      zone: "homelab.example.com",
      name: "files.homelab.example.com",
      type: "CNAME",
      target: nas.name,
    });
    return { nas: nas.name };
  }),
);
