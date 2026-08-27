/** Inline SVG icons used across the webview. Hard-coded, never model output. */

export const SEND_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 1.5l5.5 5.5-1.06 1.06L8.75 4.37V14.5h-1.5V4.37L3.56 8.06 2.5 7 8 1.5z"/></svg>`;
export const STOP_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/></svg>`;
export const CHEVRON_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M4.44 6.03L8 9.59l3.56-3.56 1.06 1.06L8 11.71 3.38 7.09l1.06-1.06z"/></svg>`;

/** Magnifier: transcript search. */
export const SEARCH_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M11.2 10.1a4.6 4.6 0 1 0-1.1 1.1l3.2 3.2 1.1-1.1-3.2-3.2zM6.7 10a3.3 3.3 0 1 1 0-6.6 3.3 3.3 0 0 1 0 6.6z"/></svg>`;

/** Circular arrow: re-issue the request a failed turn died on. */
export const RETRY_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8.5 3.05V1.4l3.2 2.1-3.2 2.1V3.95a4.05 4.05 0 1 0 4.05 4.05h1.35A5.4 5.4 0 1 1 8.5 3.05z"/></svg>`;
/* Codicon paths, embedded verbatim from microsoft/vscode-codicons
 * (src/icons/arrow-up.svg, arrow-down.svg, close.svg): the same glyphs the
 * workbench find widget uses. Do not hand-simplify them — the geometry is
 * the design. */
export const UP_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M13.854 7.14576L8.85401 2.14576C8.65901 1.95076 8.34201 1.95076 8.14701 2.14576L3.14601 7.14576C2.95101 7.34076 2.95101 7.65776 3.14601 7.85276C3.34101 8.04776 3.65801 8.04776 3.85301 7.85276L7.99901 3.70676V13.4998C7.99901 13.7758 8.22301 13.9998 8.49901 13.9998C8.77501 13.9998 8.99901 13.7758 8.99901 13.4998V3.70676L13.145 7.85276C13.243 7.95076 13.371 7.99876 13.499 7.99876C13.627 7.99876 13.755 7.94976 13.853 7.85276C14.048 7.65776 14.048 7.34076 13.853 7.14576H13.854Z"/></svg>`;
export const DOWN_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M13.854 8.146C13.659 7.951 13.342 7.951 13.147 8.146L9.00096 12.292V2.5C9.00096 2.224 8.77696 2 8.50096 2C8.22496 2 8.00096 2.224 8.00096 2.5V12.293L3.85496 8.147C3.65996 7.952 3.34296 7.952 3.14796 8.147C2.95296 8.342 2.95296 8.659 3.14796 8.854L8.14796 13.854C8.24596 13.952 8.37396 14 8.50196 14C8.62996 14 8.75796 13.951 8.85596 13.854L13.856 8.854C14.051 8.659 14.051 8.342 13.856 8.147L13.854 8.146Z"/></svg>`;
export const CLOSE_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M13.85 13.1502C14.05 13.3502 14.05 13.6602 13.85 13.8602C13.75 13.9602 13.62 14.0102 13.5 14.0102C13.38 14.0102 13.24 13.9602 13.15 13.8602L8 8.71023L2.85 13.8602C2.75 13.9602 2.62 14.0102 2.5 14.0102C2.38 14.0102 2.24 13.9602 2.15 13.8602C1.95 13.6602 1.95 13.3502 2.15 13.1502L7.3 8.00023L2.15 2.85023C1.95 2.65023 1.95 2.34023 2.15 2.14023C2.35 1.94023 2.66 1.94023 2.86 2.14023L8.01 7.29023L13.16 2.14023C13.36 1.94023 13.67 1.94023 13.87 2.14023C14.07 2.34023 14.07 2.65023 13.87 2.85023L8.72 8.00023L13.87 13.1502H13.85Z"/></svg>`;

/** Horizontal ellipsis: reveals actions collapsed by a narrow panel. */
export const MORE_ICON = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><circle cx="3.1" cy="8" r="1.55"/><circle cx="8" cy="8" r="1.55"/><circle cx="12.9" cy="8" r="1.55"/></svg>`;

/* Per-message session-tree actions, shown beside a user bubble on hover. */

/** Counter-clockwise arrow: rewind the session to this message. */
export const REWIND_ICON = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M7.5 2.2v1.35a4.45 4.45 0 1 1-4.2 4.9H1.85A5.85 5.85 0 1 0 7.5 2.15V1L4.3 3.1 7.5 5.2V3.55z"/></svg>`;
/** Git-style branch: copy this branch into a new session. */
export const BRANCH_ICON = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M4.5 2a1.6 1.6 0 0 0-.65 3.06v5.88a1.6 1.6 0 1 0 1.3 0V9.6h2.4a3.1 3.1 0 0 0 3.1-3.1V5.06A1.6 1.6 0 1 0 9.85 5.1V6.5c0 .99-.81 1.8-1.8 1.8H5.15V5.06A1.6 1.6 0 0 0 4.5 2z"/></svg>`;
/** Tag: bookmark this message for later navigation. */
export const TAG_ICON = `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M2 2h5.9l6.1 6.1-5.9 5.9L2 7.9V2zm1.3 1.3v4.05l4.8 4.8 4.05-4.05-4.8-4.8H3.3zm1.9 1.15a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8z"/></svg>`;

/** Two stacked sheets: copy the raw text of a message or a code block. */
export const COPY_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M5.5 1.5h7A1.5 1.5 0 0 1 14 3v7h-1.3V3a.2.2 0 0 0-.2-.2h-7V1.5z"/><path d="M3.5 4h6A1.5 1.5 0 0 1 11 5.5v7A1.5 1.5 0 0 1 9.5 14h-6A1.5 1.5 0 0 1 2 12.5v-7A1.5 1.5 0 0 1 3.5 4zm0 1.3a.2.2 0 0 0-.2.2v7c0 .11.09.2.2.2h6a.2.2 0 0 0 .2-.2v-7a.2.2 0 0 0-.2-.2h-6z"/></svg>`;

/* Composer quick menus (model / thinking level). */


/** Pencil: rename a session. */
export const RENAME_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M13.23 1h-1.46L3.52 9.25l-.16.22L1 13.59 2.41 15l4.12-2.36.22-.16L15 4.23V2.77L13.23 1zM2.41 13.59l1.51-3 1.45 1.45-2.96 1.55zm3.83-2.06L4.47 9.76l8-8 1.77 1.77-8 8z"/></svg>`;

/** Split view: open a session in the editor area. */
export const OPEN_IN_EDITOR_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M14.5 2h-13l-.5.5v11l.5.5h13l.5-.5v-11l.5-.5zm-7 11H2V3h5.5v10zm6.5 0H8.5V3H14v10z"/></svg>`;

/** Window with arrow: open a session in a new window. */
export const NEW_WINDOW_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M11.85 2h-7.7l-.5.5V6h1V3h7v5H9v1h3.35l.5-.5v-6l-.5-.5z"/><path d="M8.35 7h-7.7l-.5.5v6l.5.5h7.7l.5-.5v-6l-.5-.5zM7.85 13H1.15V8h6.7v5z"/><path d="M5 6V5l3 2.5L5 10V9H2V6h3z"/></svg>`;

/** Trash can: delete a session. */
export const TRASH_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M10 3h3v1h-1v9l-1 1H5l-1-1V4H3V3h3V2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1zM9 2H7v1h2V2zM5 13h6V4H5v9zm2-8H6v7h1V5zm1 0h1v7H8V5z"/></svg>`;

/** Checkmark: the row that is currently active. */
export const CHECK_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M6.2 12.3L2.4 8.5l1.06-1.06 2.74 2.74 6.34-6.34L13.6 4.9z"/></svg>`;
