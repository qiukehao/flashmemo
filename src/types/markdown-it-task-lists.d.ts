// markdown-it-task-lists and markdown-it-footnote ship no usable types
// (2026-10-03). Deliberately loose: importing markdown-it's own types here
// conflicts with the ambient @types/markdown-it copies and breaks md.use(...).
declare module "markdown-it-task-lists" {
  interface TaskListsOptions {
    /** Render checkboxes as enabled (interactive). */
    enabled?: boolean;
    /** Wrap item text in a <label>. */
    label?: boolean;
    /** Add a data-line attribute for source mapping. */
    lineNumber?: boolean;
  }

  const taskLists: (md: unknown, options?: TaskListsOptions) => void;
  export default taskLists;
}

declare module "markdown-it-footnote" {
  interface FootnoteOptions {
    /** Render footnote definitions inline instead of a trailing section. */
    inlineNotes?: boolean;
  }

  const footnote: (md: unknown, options?: FootnoteOptions) => void;
  export default footnote;
}
