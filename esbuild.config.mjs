import esbuild from "esbuild";
import process from "process";

/** Node.js built-in modules (replaces deprecated builtin-modules package). */
const builtins = [
	"assert","async_hooks","buffer","child_process","cluster","console",
	"constants","crypto","dgram","diagnostics_channel","dns","domain",
	"events","fs","http","http2","https","inspector","module","net",
	"os","path","perf_hooks","process","punycode","querystring","readline",
	"repl","stream","string_decoder","sys","timers","tls","trace_events",
	"tty","url","util","v8","vm","wasi","worker_threads","zlib",
];

const prod = process.argv[2] === "production";

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtins,
	],
	format: "cjs",
	target: "es2022",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
