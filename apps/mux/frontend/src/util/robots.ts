/**
 * The Robots utility surface, in one import.
 *
 * Split in two behind this barrel: `robotsPassthrough` decides what is *ours* — the scoped
 * passthrough, ownership, and reconciling a create whose outcome Mux never confirmed —
 * while `robotsField` turns what the API says into what the entry stores.
 */
export * from './robotsPassthrough';
export * from './robotsField';
