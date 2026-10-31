import * as Contributions from "alchemy/Contributions";

/** What the Alchemy CLI loads from this package without a stack: the Technitium login. */
export default Contributions.make({
  name: "technitium",
  auth: Contributions.lazy(
    () => import("./AuthProvider.ts"),
    (module) => module.TechnitiumAuth,
  ),
});
