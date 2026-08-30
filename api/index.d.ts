declare const app: import("hono/hono-base").HonoBase<import("hono/types").BlankEnv, import("hono/types").BlankSchema, "/api", "/api">;
declare const _default: (req: Request) => Response | Promise<Response>;
export default _default;
export { app };
