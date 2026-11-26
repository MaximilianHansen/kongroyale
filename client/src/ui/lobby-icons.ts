// Toon lobby icons (inline SVG, currentColor): the Toon lobby's line icons (target, book, pencil) plus
// the ones the game's extra lobby features need (friends, copy link, leave, alert, the Play arrow). Trusted markup only.
const svg = (vb: string, body: string, cls = "") => `<svg class="tn-play-ico${cls ? " " + cls : ""}" viewBox="${vb}" aria-hidden="true" focusable="false">${body}</svg>`;

export const ICON = {
  /** firing range: a scope reticle */
  target: svg("0 0 24 24", `<g fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/><path d="M12 1v5M12 18v5M1 12h5M18 12h5"/></g>`),
  /** learn controls: an open book */
  book: svg("0 0 28 24", `<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M14 5c-3-2-7-2.5-12-2v17c5-.5 9 0 12 2 3-2 7-2.5 12-2V3c-5-.5-9 0-12 2zM14 5v17"/>`, "wide"),
  /** edit callsign */
  pencil: svg("0 0 24 24", `<path fill="currentColor" d="M3 17.3V21h3.7L17.8 9.9l-3.7-3.7L3 17.3zM20.7 7a1 1 0 000-1.4l-2.3-2.3a1 1 0 00-1.4 0l-1.8 1.8 3.7 3.7L20.7 7z"/>`),
  /** play with friends: two heads */
  friends: svg("0 0 28 24", `<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="10" cy="8" r="4"/><path d="M2.5 21c.6-4.4 3.6-7 7.5-7s6.9 2.6 7.5 7"/><circle cx="19.5" cy="7.5" r="3.2"/><path d="M19.5 13.4c3.3 0 5.6 2.2 6 5.6"/></g>`, "wide"),
  /** copy the invite link */
  copy: svg("0 0 24 24", `<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><rect x="8" y="8" width="13" height="13" rx="2.5"/><path d="M16 8V5.5A2.5 2.5 0 0013.5 3h-8A2.5 2.5 0 003 5.5v8A2.5 2.5 0 005.5 16H8"/></g>`),
  /** leave the private lobby */
  leave: svg("0 0 24 24", `<g fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4H5.5A1.5 1.5 0 004 5.5v13A1.5 1.5 0 005.5 20H10"/><path d="M15 8l-4 4 4 4M11 12h10"/></g>`),
  /** a field error */
  alert: svg("0 0 24 24", `<g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.6v.4"/></g>`),
  /** the crown on the host's roster chip */
  crown: svg("0 0 24 20", `<path fill="currentColor" stroke="var(--kong-outline)" stroke-width="1.6" stroke-linejoin="round" d="M2 6l5 4 5-8 5 8 5-4-2 12H4z"/>`, "wide"),
  /** the big Play arrow: a chunky filled arrow (the design draws "→" with the button's 5px text outline) */
  arrow: svg("0 0 30 22", `<path fill="currentColor" stroke="currentColor" stroke-width="3" stroke-linejoin="round" d="M2.5 8.2h14.2V3l11 8-11 8v-5.2H2.5z"/>`, "arrow"),
  /** a thin "→" for the Training tiles */
  chevron: svg("0 0 26 16", `<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M1.5 8h22M17 2l6.5 6-6.5 6"/>`, "chev"),
  /** locked cosmetic padlock */
  lock: svg("0 0 20 22", `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3.5" y="9.5" width="13" height="10" rx="2"/><path d="M6.5 9.5V6.5a3.5 3.5 0 0 1 7 0v3"/></g>`),
  /** rotate 3D preview */
  rotate: svg("0 0 24 24", `<g fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 1 2.3 5.7"/><path d="M4 19v-5h5"/></g>`),
  /** randomize dice */
  dice: svg("0 0 24 24", `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><circle cx="8.5" cy="8.5" r="1.2" fill="currentColor"/><circle cx="15.5" cy="8.5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="8.5" cy="15.5" r="1.2" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.2" fill="currentColor"/></g>`),
  /** emote sparkle */
  sparkle: svg("0 0 24 24", `<path fill="currentColor" d="M12 2l2.3 6.7L21 11l-6.7 2.3L12 20l-2.3-6.7L3 11l6.7-2.3z"/>`),
} as const;
