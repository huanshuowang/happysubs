// Runs first on a site the viewer chose to always enable (see "sites the
// viewer opts into" in background.js). platform.js has no adapter of its own
// for such a site; this tells it to use the generic one — the same flag the
// popup sets when it injects by hand.
window.YDS_FORCE_GENERIC = true;
