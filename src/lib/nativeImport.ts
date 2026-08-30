import { pathToFileURL } from "url";

// TypeScript downgrades a plain `import()` expression into a
// `Promise.resolve().then(() => require(...))` when compiling to CommonJS
// (this project's module target) — which defeats the entire point of using
// dynamic import to load an ESM-only package, since it's still a require()
// under the hood and fails with ERR_REQUIRE_ESM on runtimes that don't
// transparently support requiring ESM (confirmed on Vercel's Node runtime,
// even though it works locally on Node 24, which does support it).
//
// Constructing the import() call inside `new Function` hides it from tsc's
// AST transform (tsc only rewrites `import()` it can see in parsed source),
// so this performs a genuine native dynamic import at runtime regardless of
// the calling file's compiled module system.
//
// Callers must pass `require.resolve("package-name")` — a literal string
// argument, inlined at the call site — rather than routing the package name
// through this file, because Vercel's serverless bundler (@vercel/nft)
// decides which node_modules files to ship by statically tracing
// require()/require.resolve() calls with literal arguments it can see
// directly in each compiled file. A wrapper here that took the package name
// as its own parameter would hide that literal from the tracer one level up
// and the package would be silently missing from the deployed bundle, even
// though loading it would otherwise work. require.resolve() itself never
// executes the target module, so it's safe to call even on an ESM-only
// package that require() itself cannot load.
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<any>;

// Callers pass require.resolve("pkg"), which returns an absolute filesystem
// path. On POSIX that path starts with "/" and native import() accepts it, but
// on Windows it's "C:\..." and import() throws ERR_UNSUPPORTED_ESM_URL_SCHEME
// ("Received protocol 'c:'") — it only accepts file:// URLs there. Convert any
// absolute path to a file:// URL; bare package specifiers pass through untouched.
const nativeImport = (specifier: string): Promise<any> => {
  const isAbsolutePath =
    specifier.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(specifier) || specifier.startsWith("\\\\");
  return dynamicImport(isAbsolutePath ? pathToFileURL(specifier).href : specifier);
};

export default nativeImport;
