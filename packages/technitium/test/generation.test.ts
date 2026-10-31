// Extraction (documentation and server source -> structure) and conversion (structure ->
// Smithy), with invented fragments in the shape of the real inputs.
import { describe, expect, it } from "vitest";
import { convert } from "../scripts/convert.ts";
import {
  type Adapters,
  type ApiStructure,
  extract,
  parameterTypes,
  parseDocs,
  parseExample,
  parseRoutes,
  shapeOf,
} from "../scripts/extract.ts";

const fence = "```";
const docs = `# Invented API

## Widget Calls

### Add Widget

Text about the call that is never kept.

URL:\\
\`http://localhost:5380/api/widgets/add?name=a\`

PERMISSIONS:\\
Widgets: Modify\\
Widget: None

WHERE:
- \`token\`: Text.
- \`name\`: Text.
- \`color\` (optional): Text. Valid values are [\`Red\`, \`Blue\`].
- \`size\` (optional): Text.
- \`legacy\` (optional)(obsolete, use \`size\`): Text.

RESPONSE:
${fence}
{
	"response": {
		"widget": { "name": "a", "size": 3 },
		"owners": { "example.com": "x" },
	},
	"status": "ok"
}
${fence}

WHERE:
- \`widget\`: Text about a response member, not a parameter.

### Export Widgets

URL:\\
\`http://localhost:5380/api/widgets/export\`

RESPONSE: Text with \`Content-Type: text/plain\` and more text.

### Login

URL:\\
\`http://localhost:5380/api/user/login?user=a\`

WHERE:
- \`user\`: Text.
- \`pass\`: Text.

Response:
${fence}
{
	"token": "t",
	"status": "ok"
}
${fence}
`;

const webService = `
class DnsWebService {
  readonly WidgetsApi _widgetsApi;
  readonly AuthApi _authApi;
  void Routes() {
    _webService.MapGetAndPost("/api/widgets/add", _widgetsApi.AddWidget);
    _webService.MapGetAndPost("/api/widgets/export", _widgetsApi.ExportWidgets);
    _webService.MapGetAndPost("/api/user/login", delegate (HttpContext context) { return _authApi.Login(context, true); });
    _webService.MapGetAndPost("/api/widgets/secret", _widgetsApi.Secret);
  }
}`;
const widgets = `
class WidgetsApi {
  public void AddWidget(HttpContext context) {
    HttpRequest request = context.Request;
    string name = request.GetQueryOrForm("name");
    string color = request.GetQueryOrForm("color", "Red");
    Apply(context);
  }
  private void Apply(HttpContext context) {
    // "comment with { brace"
    uint size = context.Request.GetQueryOrForm("size", ZoneFile.ParseTtl, 1u);
  }
  public void ExportWidgets(HttpContext context) { }
  public void Secret(HttpContext context) { }
}`;
const auth = `
class AuthApi {
  public Task Login(HttpContext context, bool flag) {
    bool flagged = context.Request.GetQueryOrForm("flag", bool.Parse, false);
    string user = context.Request.GetQueryOrFormAlt("user", "username");
    string pass = context.Request.GetQueryOrForm("pass");
    return Task.CompletedTask;
  }
}`;

const adapters: Adapters = { sameResponse: {}, uploads: new Set(), optionalUploads: new Set() };
const handlers = { WidgetsApi: widgets, AuthApi: auth };

describe("extraction", () => {
  it("reads URL, permissions, parameters and response examples, and no prose", () => {
    const [add, exported, login] = parseDocs(docs);
    expect(add).toEqual({
      title: "Add Widget",
      path: "/api/widgets/add",
      permissions: ["Widgets: Modify", "Widget: None"],
      parameters: [
        { name: "token", optional: false, obsolete: false },
        { name: "name", optional: false, obsolete: false },
        { name: "color", optional: true, obsolete: false, enum: ["Red", "Blue"] },
        { name: "size", optional: true, obsolete: false },
        { name: "legacy", optional: true, obsolete: true },
      ],
      responseExamples: [expect.stringContaining('"widget"')],
      responseContentType: undefined,
      mentionsUpload: false,
    });
    expect(exported).toMatchObject({
      path: "/api/widgets/export",
      responseContentType: "text/plain",
    });
    expect(login).toMatchObject({
      path: "/api/user/login",
      responseExamples: [expect.any(String)],
    });
  });

  it("repairs the two kinds of broken examples in the documentation", () => {
    expect(parseExample('{\n\t"a": 1,\n}')).toEqual({ value: { a: 1 }, repaired: true });
    expect(parseExample('{\n\t"a": "x"\n\t"b": true\n}')).toEqual({
      value: { a: "x", b: true },
      repaired: true,
    });
    expect(() => parseExample("{ nope }")).toThrow();
  });

  it("keeps shapes, not values, and treats data keys as maps", () => {
    expect(shapeOf({ list: [{ a: 1 }, { b: "x" }], byZone: { "example.com": true } })).toEqual({
      type: "object",
      properties: {
        byZone: { type: "map", values: { type: "boolean" } },
        list: {
          type: "array",
          items: { type: "object", properties: { a: { type: "number" }, b: { type: "string" } } },
        },
      },
    });
  });

  it("types parameters from the handler and the helpers it passes the request to", () => {
    const routes = parseRoutes(webService);
    expect(routes.get("/api/user/login")).toEqual({
      className: "AuthApi",
      method: "Login",
      postOnly: false,
    });
    const types = parameterTypes(widgets, "AddWidget");
    expect(Object.fromEntries([...types].map(([name, set]) => [name, [...set]]))).toEqual({
      name: ["string"],
      color: ["string"],
      size: ["integer"],
    });
    expect([...(parameterTypes(auth, "Login").get("username") ?? [])]).toEqual(["string"]);
  });

  it("builds the structure and reports routes the documentation does not describe", () => {
    const { structure, report } = extract({ docs, webService, handlers }, adapters);
    expect(structure.undocumentedRoutes).toEqual(["/api/widgets/secret"]);
    expect(report.repairedExamples).toEqual(["/api/widgets/add"]);
    const [add, exported, login] = structure.operations;
    expect(add?.parameters).toEqual([
      { name: "name", required: true, type: "string" },
      { name: "color", required: false, type: "string", enum: ["Red", "Blue"] },
      { name: "size", required: false, type: "integer" },
    ]);
    expect(add?.response).toEqual({
      kind: "json",
      wrapped: true,
      shape: shapeOf({ widget: { name: "a", size: 3 }, owners: { "example.com": "x" } }),
    });
    expect(exported?.response).toEqual({ kind: "file", contentType: "text/plain" });
    expect(login?.response).toEqual({
      kind: "json",
      wrapped: false,
      shape: shapeOf({ token: "t" }),
    });
  });

  it("fails when the documentation describes a route the server does not map", () => {
    const stale = docs.replace("/api/widgets/export", "/api/widgets/gone");
    expect(() => extract({ docs: stale, webService, handlers }, adapters)).toThrow(
      "/api/widgets/gone is documented but the server maps no such route",
    );
  });
});

describe("conversion", () => {
  const structure: ApiStructure = {
    undocumentedRoutes: [],
    operations: [
      {
        path: "/api/widgets/add",
        title: "Add Widget",
        permissions: ["Widgets: None", "Widget: Modify"],
        parameters: [
          { name: "name", required: true, type: "string" },
          { name: "color", required: false, type: "string", enum: ["Red", "Blue"] },
          { name: "size", required: false, type: "integer" },
          { name: "pass", required: false, type: "string" },
        ],
        response: {
          kind: "json",
          wrapped: true,
          shape: shapeOf({ widget: { token: "t" }, owners: { "a.b": 1 } }),
        },
        request: "form",
      },
      {
        path: "/api/widgets/export",
        title: "Export Widgets",
        permissions: [],
        parameters: [],
        response: { kind: "file", contentType: "text/plain" },
        request: "form",
      },
    ],
  };

  it("emits one POST operation per call, with typed and sensitive members", () => {
    const { models, skipped } = convert(structure, "Invented 1.0");
    expect(skipped).toEqual([
      { path: "/api/widgets/export", reason: "downloads a file (text/plain)" },
    ]);
    const shapes = models.widgets?.shapes ?? {};
    expect(shapes["technitium.widgets#AddWidget"]?.traits).toEqual({
      "smithy.api#http": { method: "POST", uri: "/api/widgets/add", code: 200 },
      "smithy.api#documentation": "POST /api/widgets/add. Permissions: Widget: Modify.",
    });
    expect(shapes["technitium.widgets#AddWidgetRequest"]?.members).toEqual({
      name: { target: "smithy.api#String", traits: { "smithy.api#required": {} } },
      color: { target: "technitium.widgets#AddWidgetRequestColor" },
      size: { target: "smithy.api#Integer" },
      pass: { target: "smithy.api#String", traits: { "smithy.api#sensitive": {} } },
    });
    expect(shapes["technitium.widgets#AddWidgetRequestColor"]?.type).toBe("enum");
    expect(shapes["technitium.widgets#AddWidgetResponseWidget"]?.members?.token).toEqual({
      target: "smithy.api#String",
      traits: { "smithy.api#sensitive": {}, "technitium.api#redactedOutput": {} },
    });
    expect(shapes["technitium.widgets#AddWidgetResponseOwners"]?.type).toBe("map");
  });
});
