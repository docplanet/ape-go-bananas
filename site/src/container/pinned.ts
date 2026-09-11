// The pinned Claude Code, in one place.
//
// From v2.1.113 the npm package ships a per-platform native binary, which
// cannot execute on a WebAssembly Node; 2.1.112 is the last JavaScript build.
// Anthropic's own note on that change is "If you need the JS build, pin to an
// earlier version", so this is the sanctioned path rather than a trick.
//
// It lives alone so the rail can name the version without importing the
// container host, which drags in WebContainer and the whole mounted engine.
export const CLAUDE_JS_VERSION = '2.1.112';

/** What that build's model picker tops out at -- checked against its own strings, not guessed. */
export const CLAUDE_JS_TOP_MODELS = 'Opus 4.7 / Sonnet 4.6';
