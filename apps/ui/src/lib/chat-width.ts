/**
 * The chat column's reading width, from T3 Code's chat view
 * (https://github.com/pingdotgg/t3code, `apps/web/src/index.css`:
 * `--chat-content-max-width: 46rem`, the default "comfortable" width that its
 * timeline and composer share). The Sessions page and task details (with the
 * side panel closed) center their transcript and composer at this width.
 */
export const CHAT_MAX_WIDTH = "max-w-[46rem]";

/** The centered chat column. */
export const CHAT_COLUMN = `mx-auto w-full ${CHAT_MAX_WIDTH}`;
