/**
 * A bounded-context HTTP route group and its public URL prefix.
 *
 * The shared kernel knows neither Fastify nor a context's dependencies. The
 * application supplies its framework plugin type, then maps each context to
 * its own prefix at the composition boundary.
 */
export interface RouteRegistration<TPlugin> {
  readonly prefix: string;
  readonly plugin: TPlugin;
}
