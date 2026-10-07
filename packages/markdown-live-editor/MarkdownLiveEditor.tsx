import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "@tiptap/markdown";
import { common, createLowlight } from "lowlight";
import {
  Bold,
  BookmarkPlus,
  Code2,
  Copy,
  Eye,
  Heading1,
  Heading2,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTree,
  Pencil,
  Quote,
  Redo2,
  Strikethrough,
  Terminal,
  Undo2,
  X,
} from "lucide-react";
import { BookmarkCard } from "./BookmarkCardExtension.tsx";
import { MarkdownPreview } from "./MarkdownPreview.tsx";
import { WikiLink } from "./WikiLinkExtension.tsx";
import { hasContentPreservingMarkdownRoundTrip, type MarkdownSerializationApi } from "./markdown-roundtrip.ts";
import {
  detectMarkdownLineEndingStyle,
  restoreMarkdownLineEndings,
  splitTerminalNewlineSuffix,
  stripNormalizedTerminalNewlines,
} from "./markdown-line-endings.ts";
import {
  isStandaloneWebUrl,
  safeHttpUrl,
  safeImageSource,
  splitLeadingFrontmatter,
} from "./markdown-safety.ts";
import { extractHeadings } from "./markdown-structure.ts";
import type { EditorSnippet, MarkdownLiveEditorAdapters, MarkdownLiveEditorProps } from "./types.ts";

const lowlight = createLowlight(common);
const CODE_LANGUAGES = ["plaintext", "javascript", "typescript", "json", "html", "css", "bash", "python", "sql", "yaml", "markdown"] as const;

type EditorWithMarkdown = Editor & { markdown?: MarkdownSerializationApi };
type SourceModeReason = "roundtrip" | "paste";

function shortcutMatches(event: KeyboardEvent, shortcut: string | null | undefined): boolean {
  if (!shortcut) return false;
  const parts = shortcut.toLowerCase().split("+").filter(Boolean);
  const modifiers = new Set(["ctrl", "meta", "cmd", "shift", "alt"]);
  const key = parts.find((part) => !modifiers.has(part));
  if (!key) return false;
  const wantsCtrl = parts.includes("ctrl");
  const wantsMeta = parts.includes("meta") || parts.includes("cmd");
  const wantsShift = parts.includes("shift");
  const wantsAlt = parts.includes("alt");
  const keyMatches = event.key.toLowerCase() === key || event.code.toLowerCase() === "key" + key || event.code.toLowerCase() === "digit" + key;
  return keyMatches && event.ctrlKey === wantsCtrl && event.metaKey === wantsMeta && event.shiftKey === wantsShift && event.altKey === wantsAlt;
}

function ToolbarButton({
  label,
  children,
  onClick,
  disabled = false,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="mle-tool-button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onMouseDown={(event: ReactMouseEvent<HTMLButtonElement>) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * A controlled Markdown editor. The component owns no storage or network
 * endpoints; all persistence and metadata work is supplied by adapters.
 */
export function MarkdownLiveEditor({
  value,
  onChange,
  adapters,
  ariaLabel = "Markdown editor",
  minHeight = 420,
  onFocus,
  showPreviewTab = true,
}: MarkdownLiveEditorProps) {
  const initialParts = useRef(splitLeadingFrontmatter(value));
  const adaptersRef = useRef<MarkdownLiveEditorAdapters | undefined>(adapters);
  const onChangeRef = useRef(onChange);
  const frontmatterRef = useRef(initialParts.current.frontmatter);
  const lineEndingStyleRef = useRef(detectMarkdownLineEndingStyle(initialParts.current.body));
  const terminalNewlineSuffixRef = useRef(splitTerminalNewlineSuffix(initialParts.current.body).suffix);
  const incomingValueRef = useRef(value);
  const emittedValueRef = useRef<string | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const imageInsertRangeRef = useRef<{ from: number; to: number } | null>(null);
  const linkRangeRef = useRef<{ from: number; to: number } | null>(null);
  const richModeRef = useRef(false);
  const composingRef = useRef(false);
  const sourceTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const focusSourceAfterFallbackRef = useRef(false);
  const sourceFallbackTimerRef = useRef<number | null>(null);

  adaptersRef.current = adapters;
  onChangeRef.current = onChange;
  const currentParts = splitLeadingFrontmatter(value);
  frontmatterRef.current = currentParts.frontmatter;
  lineEndingStyleRef.current = detectMarkdownLineEndingStyle(currentParts.body);
  terminalNewlineSuffixRef.current = splitTerminalNewlineSuffix(currentParts.body).suffix;

  const [pane, setPane] = useState<"write" | "preview">("write");
  const [roundTripState, setRoundTripState] = useState<"checking" | "rich" | "source">("checking");
  const [sourceReason, setSourceReason] = useState<SourceModeReason | null>(null);
  const [status, setStatus] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [activeCodeLanguage, setActiveCodeLanguage] = useState<string | null>(null);
  const [isLinkOpen, setIsLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const [linkError, setLinkError] = useState("");
  const [isBookmarkOpen, setIsBookmarkOpen] = useState(false);
  const [bookmarkUrl, setBookmarkUrl] = useState("");
  const [bookmarkError, setBookmarkError] = useState("");
  const [menu, setMenu] = useState<"toc" | "snippets" | null>(null);
  const [snippets, setSnippets] = useState<EditorSnippet[]>([]);
  const [snippetName, setSnippetName] = useState("");
  const [snippetContent, setSnippetContent] = useState("");
  const [snippetShortcut, setSnippetShortcut] = useState("");
  const [editingSnippetId, setEditingSnippetId] = useState<string | null>(null);
  const [snippetError, setSnippetError] = useState("");

  const cancelSourceFallback = useCallback(() => {
    if (sourceFallbackTimerRef.current !== null) {
      window.clearTimeout(sourceFallbackTimerRef.current);
      sourceFallbackTimerRef.current = null;
    }
  }, []);

  const switchToSource = useCallback((reason: SourceModeReason, message: string, restoreFocus = false) => {
    cancelSourceFallback();
    focusSourceAfterFallbackRef.current = restoreFocus;
    richModeRef.current = false;
    setSourceReason(reason);
    setRoundTripState("source");
    setStatus(message);
  }, [cancelSourceFallback]);

  const scheduleSourceFallback = useCallback((activeEditor: Editor) => {
    cancelSourceFallback();
    sourceFallbackTimerRef.current = window.setTimeout(() => {
      sourceFallbackTimerRef.current = null;
      const currentEditor = editorRef.current;
      if (!currentEditor || currentEditor.isDestroyed || !richModeRef.current || composingRef.current) return;
      try {
        const markdownApi = (currentEditor as EditorWithMarkdown).markdown;
        if (!markdownApi || !hasContentPreservingMarkdownRoundTrip(markdownApi, currentEditor.getMarkdown())) {
          switchToSource("roundtrip", "This Markdown needs source mode to avoid changing its syntax.", activeEditor.isFocused);
        }
      } catch {
        switchToSource("roundtrip", "Markdown serialization failed. The original source remains available below.", activeEditor.isFocused);
      }
    }, 2500);
  }, [cancelSourceFallback, switchToSource]);

  const fetchMetadataAdapter = useCallback((url: string, signal: AbortSignal) => {
    const fetchMetadata = adaptersRef.current?.fetchBookmarkMetadata;
    return fetchMetadata ? fetchMetadata(url, signal) : Promise.resolve(null);
  }, []);

  const extensions = useMemo(
    () => [
      StarterKit.configure({ codeBlock: false, link: false }),
      CodeBlockLowlight.configure({ lowlight, defaultLanguage: "plaintext" }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: false,
        protocols: ["http", "https"],
        isAllowedUri: (url, context) => Boolean(safeHttpUrl(url)) && context.defaultValidate(url),
        HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
      }),
      Image.configure({ inline: false, allowBase64: false }),
      Placeholder.configure({ placeholder: "Write in Markdown…", emptyEditorClass: "mle-empty" }),
      WikiLink,
      Markdown.configure({ markedOptions: { gfm: true, breaks: false } }),
      BookmarkCard.configure({ fetchBookmarkMetadata: fetchMetadataAdapter }),
    ],
    [fetchMetadataAdapter]
  );

  const insertUploadedImage = useCallback(async (file: File, position?: number | { from: number; to: number }) => {
    if (!file.type.startsWith("image/")) {
      setStatus("Choose an image file to attach.");
      return;
    }
    const uploadImage = adaptersRef.current?.uploadImage;
    if (!uploadImage) {
      setStatus("Image upload is unavailable until an upload adapter is supplied.");
      return;
    }

    setIsUploading(true);
    setStatus("Uploading image…");
    try {
      const returnedSource = await uploadImage(file);
      const src = safeImageSource(returnedSource);
      const activeEditor = editorRef.current;
      if (!src || !activeEditor || activeEditor.isDestroyed) {
        setStatus("The upload adapter returned an unsafe image URL.");
        return;
      }
      const name = file.name.replace(/\.[^.]+$/, "") || "image";
      if (position !== undefined) {
        const range = typeof position === "number" ? { from: position, to: position } : position;
        const safeRange = {
          from: Math.max(0, Math.min(range.from, activeEditor.state.doc.content.size)),
          to: Math.max(0, Math.min(range.to, activeEditor.state.doc.content.size)),
        };
        activeEditor.chain().setTextSelection(safeRange).focus().setImage({ src, alt: name }).run();
      } else {
        activeEditor.chain().focus().setImage({ src, alt: name }).run();
      }
      setStatus("Image inserted.");
    } catch {
      setStatus("Image upload failed.");
    } finally {
      setIsUploading(false);
    }
  }, []);

  const updateMarkdown = useCallback((activeEditor: Editor) => {
    if (!richModeRef.current) return;
    try {
      const markdown = activeEditor.getMarkdown();
      const content = stripNormalizedTerminalNewlines(markdown);
      const nextBody = restoreMarkdownLineEndings(content, lineEndingStyleRef.current || "lf") + terminalNewlineSuffixRef.current;
      const nextValue = frontmatterRef.current + nextBody;
      if (nextValue !== incomingValueRef.current) {
        emittedValueRef.current = nextValue;
        onChangeRef.current(nextValue);
      }

      const markdownApi = (activeEditor as EditorWithMarkdown).markdown;
      if (markdownApi && hasContentPreservingMarkdownRoundTrip(markdownApi, markdown)) cancelSourceFallback();
      else if (!composingRef.current) scheduleSourceFallback(activeEditor);
    } catch {
      if (!composingRef.current) scheduleSourceFallback(activeEditor);
    }
  }, [cancelSourceFallback, scheduleSourceFallback]);

  const editor = useEditor(
    {
      extensions,
      content: initialParts.current.body,
      contentType: "markdown",
      immediatelyRender: false,
      editorProps: {
        attributes: {
          class: "mle-prosemirror",
          role: "textbox",
          "aria-label": ariaLabel,
          "aria-multiline": "true",
          spellcheck: "true",
        },
        handleDOMEvents: {
          compositionstart: () => {
            composingRef.current = true;
            return false;
          },
          compositionend: () => {
            composingRef.current = false;
            queueMicrotask(() => {
              const activeEditor = editorRef.current;
              if (!activeEditor || activeEditor.isDestroyed || !richModeRef.current) return;
              try {
                const markdown = activeEditor.getMarkdown();
                const markdownApi = (activeEditor as EditorWithMarkdown).markdown;
                if (markdownApi && hasContentPreservingMarkdownRoundTrip(markdownApi, markdown)) cancelSourceFallback();
                else scheduleSourceFallback(activeEditor);
              } catch {
                scheduleSourceFallback(activeEditor);
              }
            });
            return false;
          },
        },
        handlePaste: (view, event) => {
          const imageFile = Array.from(event.clipboardData?.files || []).find((file) => file.type.startsWith("image/"));
          if (imageFile && adaptersRef.current?.uploadImage) {
            const position = view.state.selection.from;
            void insertUploadedImage(imageFile, position);
            return true;
          }

          const text = event.clipboardData?.getData("text/plain") || "";
          if (!text) return false;
          const activeEditor = editorRef.current;
          if (activeEditor && activeEditor.state.selection.empty && isStandaloneWebUrl(text.trim())) {
            activeEditor.commands.insertBookmarkCard({ url: text.trim() });
            return true;
          }
          const markdownApi = activeEditor && (activeEditor as EditorWithMarkdown).markdown;
          if (!markdownApi || !hasContentPreservingMarkdownRoundTrip(markdownApi, text)) {
            setPane("write");
            switchToSource("paste", "Rich editing would change this Markdown's content or structure. Source mode is open; paste again there to preserve it.", activeEditor?.isFocused ?? false);
            return true;
          }
          activeEditor.commands.insertContent(text, { contentType: "markdown" });
          return true;
        },
        handleDrop: (view, event) => {
          const imageFile = Array.from(event.dataTransfer?.files || []).find((file) => file.type.startsWith("image/"));
          if (!imageFile || !adaptersRef.current?.uploadImage) return false;
          const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
          void insertUploadedImage(imageFile, position);
          return true;
        },
      },
      onSelectionUpdate: ({ editor: activeEditor }) => {
        const language = activeEditor.isActive("codeBlock")
          ? activeEditor.getAttributes("codeBlock").language || "plaintext"
          : null;
        setActiveCodeLanguage(language);
      },
      onUpdate: ({ editor: activeEditor }) => updateMarkdown(activeEditor),
    },
    [extensions, updateMarkdown, ariaLabel, insertUploadedImage, switchToSource, scheduleSourceFallback, cancelSourceFallback]
  );

  useEffect(() => {
    if (!editor) return;
    editorRef.current = editor;
    const parts = splitLeadingFrontmatter(value);
    frontmatterRef.current = parts.frontmatter;

    if (emittedValueRef.current === value) {
      emittedValueRef.current = null;
      incomingValueRef.current = value;
      return;
    }

    if (incomingValueRef.current !== value) {
      editor.commands.setContent(parts.body, { contentType: "markdown", emitUpdate: false });
      incomingValueRef.current = value;
    }

    const markdownApi = (editor as EditorWithMarkdown).markdown;
    const canEditRich = lineEndingStyleRef.current !== null
      && markdownApi !== undefined
      && hasContentPreservingMarkdownRoundTrip(markdownApi, parts.body, true);
    cancelSourceFallback();
    richModeRef.current = canEditRich;
    setSourceReason(canEditRich ? null : "roundtrip");
    setRoundTripState(canEditRich ? "rich" : "source");
  }, [editor, value, cancelSourceFallback]);

  useEffect(() => () => cancelSourceFallback(), [cancelSourceFallback]);

  useEffect(() => {
    if (!focusSourceAfterFallbackRef.current || roundTripState !== "source") return;
    focusSourceAfterFallbackRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      const textarea = sourceTextareaRef.current;
      if (!textarea) return;
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [roundTripState, value]);

  useEffect(() => {
    if (!showPreviewTab) setPane("write");
  }, [showPreviewTab]);

  useEffect(() => () => {
    editorRef.current = null;
  }, []);

  useEffect(() => {
    const list = adaptersRef.current?.listSnippets;
    if (!list) return;
    let active = true;
    void list().then((items) => {
      if (active) setSnippets(items);
    }).catch(() => {
      if (active) setSnippetError("Unable to load snippets.");
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!editor) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!editor.isFocused) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        const { from, to } = editor.state.selection;
        linkRangeRef.current = { from, to };
        setLinkValue(editor.getAttributes("link").href || "");
        setLinkError("");
        setIsLinkOpen(true);
        return;
      }

      if (event.key === "Tab") {
        const { $from } = editor.state.selection;
        let inList = false;
        for (let depth = $from.depth; depth > 0; depth -= 1) {
          if ($from.node(depth).type.name === "listItem") {
            inList = true;
            break;
          }
        }
        if (inList) {
          event.preventDefault();
          if (event.shiftKey) editor.chain().focus().liftListItem("listItem").run();
          else editor.chain().focus().sinkListItem("listItem").run();
        }
      }

      const match = snippets.find((snippet) => shortcutMatches(event, snippet.shortcut));
      if (match) {
        event.preventDefault();
        editor.commands.insertContent(match.content, { contentType: "markdown" });
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [editor, snippets]);

  const body = splitLeadingFrontmatter(value).body;
  const frontmatter = splitLeadingFrontmatter(value).frontmatter;
  const headings = useMemo(() => extractHeadings(body), [body]);
  const minHeightStyle = {
    "--mle-min-height": typeof minHeight === "number" ? minHeight + "px" : minHeight,
  } as CSSProperties;
  const canUpload = Boolean(adapters?.uploadImage);
  const canManageSnippets = Boolean(adapters?.listSnippets || adapters?.saveSnippet || adapters?.deleteSnippet);

  const toggleMark = (mark: "bold" | "italic" | "strike" | "code") => {
    if (!editor) return;
    editor.chain().focus().toggleMark(mark).run();
  };

  const copyActiveCodeBlock = async () => {
    if (!editor) return;
    const { $from } = editor.state.selection;
    let code: string | null = null;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      const node = $from.node(depth);
      if (node.type.name === "codeBlock") {
        code = node.textContent;
        break;
      }
    }
    if (code === null) return;
    try {
      await navigator.clipboard.writeText(code);
      setStatus("Code block copied.");
    } catch {
      setStatus("Clipboard access is unavailable.");
    }
  };

  const applyLink = () => {
    if (!editor) return;
    const url = safeHttpUrl(linkValue);
    if (!url) {
      setLinkError("Enter an http:// or https:// URL without credentials.");
      return;
    }
    const range = linkRangeRef.current;
    if (range && range.from !== range.to) {
      editor.chain().setTextSelection(range).focus().setLink({ href: url }).run();
    } else {
      const text = [{ type: "text", text: url, marks: [{ type: "link", attrs: { href: url } }] }];
      if (range) editor.chain().setTextSelection(range).focus().insertContent(text).run();
      else editor.chain().focus().insertContent(text).run();
    }
    setIsLinkOpen(false);
  };

  const removeLink = () => {
    if (!editor) return;
    const range = linkRangeRef.current;
    const chain = range ? editor.chain().setTextSelection(range) : editor.chain();
    chain.focus().extendMarkRange("link").unsetLink().run();
    setIsLinkOpen(false);
  };

  const insertBookmark = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const url = safeHttpUrl(bookmarkUrl.trim());
    if (!url || !isStandaloneWebUrl(bookmarkUrl.trim())) {
      setBookmarkError("Enter one http:// or https:// web address.");
      return;
    }
    if (!editor?.commands.insertBookmarkCard({ url })) {
      setBookmarkError("This address could not be inserted as a bookmark card.");
      return;
    }
    setBookmarkError("");
    setIsBookmarkOpen(false);
    editor.commands.focus();
  };

  const handleSourceEdit = (nextBody: string) => {
    const nextValue = frontmatter + nextBody;
    if (nextValue === incomingValueRef.current) return;
    emittedValueRef.current = nextValue;
    onChangeRef.current(nextValue);
  };

  const handleImageSelect = (event: FormEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = Array.from(input.files || []);
    input.value = "";
    const insertionRange = imageInsertRangeRef.current;
    imageInsertRangeRef.current = null;
    for (const file of files) void insertUploadedImage(file, insertionRange ?? undefined);
  };

  const saveSnippet = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const save = adaptersRef.current?.saveSnippet;
    if (!save || !snippetName.trim() || !snippetContent.trim()) return;
    try {
      const saved = await save({
        ...(editingSnippetId ? { id: editingSnippetId } : {}),
        name: snippetName.trim(),
        content: snippetContent,
        shortcut: snippetShortcut.trim() || null,
      });
      setSnippets((current) => {
        const withoutSaved = current.filter((item) => item.id !== saved.id);
        return [...withoutSaved, saved];
      });
      setEditingSnippetId(null);
      setSnippetName("");
      setSnippetContent("");
      setSnippetShortcut("");
      setSnippetError("");
      setStatus("Snippet saved.");
    } catch {
      setSnippetError("Unable to save snippet.");
    }
  };

  const deleteSnippet = async (id: string) => {
    const remove = adaptersRef.current?.deleteSnippet;
    if (!remove) return;
    try {
      await remove(id);
      setSnippets((current) => current.filter((item) => item.id !== id));
      if (editingSnippetId === id) {
        setEditingSnippetId(null);
        setSnippetName("");
        setSnippetContent("");
        setSnippetShortcut("");
      }
      setSnippetError("");
    } catch {
      setSnippetError("Unable to delete snippet.");
    }
  };

  const editSnippet = (snippet: EditorSnippet) => {
    setEditingSnippetId(snippet.id);
    setSnippetName(snippet.name);
    setSnippetContent(snippet.content);
    setSnippetShortcut(snippet.shortcut || "");
  };

  const insertSnippet = (snippet: EditorSnippet) => {
    editor?.commands.insertContent(snippet.content, { contentType: "markdown" });
    editor?.commands.focus();
    setMenu(null);
  };

  const scrollToHeading = (index: number) => {
    const editorElement = editor?.view.dom;
    const nodes = editorElement?.querySelectorAll("h1, h2, h3, h4, h5, h6");
    nodes?.item(index)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setMenu(null);
  };

  return (
    <section
      className="mle-shell"
      style={minHeightStyle}
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLElement && event.target.closest(".mle-editor-content, .mle-source-textarea")) onFocus?.();
      }}
    >
      {(showPreviewTab || frontmatter) && <div className="mle-header">
        {showPreviewTab && <div className="mle-mode-tabs" role="tablist" aria-label="Editor view">
          <button type="button" role="tab" aria-selected={pane === "write"} className={pane === "write" ? "is-active" : ""} onClick={() => setPane("write")}>
            <Pencil aria-hidden="true" /> Write
          </button>
            <button type="button" role="tab" aria-selected={pane === "preview"} className={pane === "preview" ? "is-active" : ""} onClick={() => setPane("preview")}>
              <Eye aria-hidden="true" /> Preview
            </button>
        </div>}
        {frontmatter && <span className="mle-frontmatter-badge" title="Frontmatter remains unchanged while editing the body">Frontmatter preserved</span>}
      </div>}

      {pane === "write" && roundTripState === "rich" && editor && (
        <>
          <div className="mle-toolbar" role="toolbar" aria-label="Markdown formatting">
            <ToolbarButton label="Heading 1" onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}><Heading1 /></ToolbarButton>
            <ToolbarButton label="Heading 2" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 /></ToolbarButton>
            <span className="mle-toolbar-divider" aria-hidden="true" />
            <ToolbarButton label="Bold" onClick={() => toggleMark("bold")}><Bold /></ToolbarButton>
            <ToolbarButton label="Italic" onClick={() => toggleMark("italic")}><Italic /></ToolbarButton>
            <ToolbarButton label="Strikethrough" onClick={() => toggleMark("strike")}><Strikethrough /></ToolbarButton>
            <ToolbarButton label="Inline code" onClick={() => toggleMark("code")}><Code2 /></ToolbarButton>
            <ToolbarButton label="Code block" onClick={() => editor.chain().focus().toggleCodeBlock().run()}><Terminal /></ToolbarButton>
            <ToolbarButton label="Bullet list" onClick={() => editor.chain().focus().toggleBulletList().run()}><List /></ToolbarButton>
            <ToolbarButton label="Numbered list" onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered /></ToolbarButton>
            <ToolbarButton label="Blockquote" onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote /></ToolbarButton>
            <span className="mle-toolbar-divider" aria-hidden="true" />
            <ToolbarButton label="Insert link (Command or Control K)" onClick={() => {
              const { from, to } = editor.state.selection;
              linkRangeRef.current = { from, to };
              setLinkValue(editor.getAttributes("link").href || "");
              setLinkError("");
              setIsLinkOpen(true);
            }}><Link2 /></ToolbarButton>
            <ToolbarButton label="Insert bookmark card" onClick={() => {
              setBookmarkUrl("");
              setBookmarkError("");
              setIsBookmarkOpen(true);
            }}><BookmarkPlus /></ToolbarButton>
            <ToolbarButton label="Upload image" disabled={!canUpload || isUploading} onClick={() => {
              const selection = editor.state.selection;
              const selectedBookmark = selection instanceof NodeSelection && selection.node.type.name === "bookmarkCard";
              const insertion = selectedBookmark
                ? selection.to
                : selection.from;
              imageInsertRangeRef.current = selectedBookmark
                ? { from: insertion, to: insertion }
                : { from: selection.from, to: selection.to };
              uploadInputRef.current?.click();
            }}><ImagePlus /></ToolbarButton>
            <input ref={uploadInputRef} className="mle-visually-hidden" type="file" accept="image/*" multiple onChange={handleImageSelect} aria-label="Choose image files" />
            <ToolbarButton label="Undo" onClick={() => editor.chain().focus().undo().run()}><Undo2 /></ToolbarButton>
            <ToolbarButton label="Redo" onClick={() => editor.chain().focus().redo().run()}><Redo2 /></ToolbarButton>
            {activeCodeLanguage !== null && (
              <>
                <select
                  className="mle-language-select"
                  aria-label="Code block language"
                  value={activeCodeLanguage}
                  onChange={(event) => {
                    const language = event.currentTarget.value;
                    editor.chain().focus().updateAttributes("codeBlock", { language }).run();
                    setActiveCodeLanguage(language);
                  }}
                >
                  {CODE_LANGUAGES.map((language) => <option key={language} value={language}>{language}</option>)}
                </select>
                <ToolbarButton label="Copy code block" onClick={() => void copyActiveCodeBlock()}><Copy /></ToolbarButton>
              </>
            )}
            <span className="mle-toolbar-spacer" />
            <ToolbarButton label="Table of contents" disabled={headings.length === 0} onClick={() => setMenu(menu === "toc" ? null : "toc")}><ListTree /><span>Outline</span></ToolbarButton>
            {canManageSnippets && (
              <ToolbarButton label="Snippets" onClick={() => setMenu(menu === "snippets" ? null : "snippets")}>Snips</ToolbarButton>
            )}
          </div>

          {menu === "toc" && (
            <nav className="mle-popover mle-toc" aria-label="Table of contents">
              {headings.length ? headings.map((heading) => (
                <button key={heading.index} type="button" className="mle-toc-item" data-level={heading.level} onMouseDown={(event) => event.preventDefault()} onClick={() => scrollToHeading(heading.index)}>
                  {heading.text}
                </button>
              )) : <p className="mle-muted">Add a heading to build the outline.</p>}
            </nav>
          )}

          {menu === "snippets" && (
            <div className="mle-popover mle-snippet-panel" aria-label="Reusable snippets">
              {snippets.length ? snippets.map((snippet) => (
                <div className="mle-snippet-row" key={snippet.id}>
                  <button type="button" className="mle-snippet-insert" onMouseDown={(event) => event.preventDefault()} onClick={() => insertSnippet(snippet)}>
                    <strong>{snippet.name}</strong><code>{snippet.content.slice(0, 32)}</code>
                    {snippet.shortcut && <small>{snippet.shortcut}</small>}
                  </button>
                  {adapters?.saveSnippet && <button type="button" className="mle-quiet-button" onClick={() => editSnippet(snippet)}>Edit</button>}
                  {adapters?.deleteSnippet && <button type="button" className="mle-quiet-button" onClick={() => void deleteSnippet(snippet.id)} aria-label={"Delete " + snippet.name}><X /></button>}
                </div>
              )) : <p className="mle-muted">No snippets saved.</p>}

              {adapters?.saveSnippet && (
                <form className="mle-snippet-form" onSubmit={(event) => void saveSnippet(event)}>
                  <label>Name<input value={snippetName} onChange={(event) => setSnippetName(event.target.value)} maxLength={80} required /></label>
                  <label>Markdown<textarea value={snippetContent} onChange={(event) => setSnippetContent(event.target.value)} rows={3} required /></label>
                  <label>Shortcut<input value={snippetShortcut} onChange={(event) => setSnippetShortcut(event.target.value)} placeholder="ctrl+shift+m" maxLength={64} /></label>
                  <div className="mle-snippet-actions">
                    <button className="mle-action-button" type="submit">{editingSnippetId ? "Update snippet" : "Save snippet"}</button>
                    {editingSnippetId && <button type="button" className="mle-quiet-button" onClick={() => { setEditingSnippetId(null); setSnippetName(""); setSnippetContent(""); setSnippetShortcut(""); }}>Cancel</button>}
                  </div>
                  {snippetError && <p className="mle-error" role="status">{snippetError}</p>}
                </form>
              )}
            </div>
          )}

          <div className="mle-editor-content">
            <EditorContent editor={editor} />
          </div>
        </>
      )}

      {pane === "write" && roundTripState === "checking" && (
        <div className="mle-checking" role="status">Checking Markdown preservation…</div>
      )}

      {pane === "write" && roundTripState === "source" && (
        <div className="mle-source-fallback">
          <p className="mle-preservation-message" role="status">
            {sourceReason === "paste"
                ? "Rich editing would change this Markdown's content or structure. Paste again here to preserve every character."
                : "Rich editing is disabled for this note because parsing or serialization changes its content or structure."}
          </p>
          {frontmatter && <pre className="mle-frontmatter" aria-label="Protected frontmatter">{frontmatter}</pre>}
          <textarea
            ref={sourceTextareaRef}
            className="mle-source-textarea"
            aria-label={ariaLabel + " source"}
            value={body}
            onChange={(event) => handleSourceEdit(event.target.value)}
            spellCheck={false}
            style={{ minHeight: "var(--mle-min-height)" }}
          />
        </div>
      )}

      {pane === "preview" && showPreviewTab && <MarkdownPreview frontmatter={frontmatter} body={body} adapters={adapters} />}

      {status && <p className="mle-status" role="status">{status}</p>}
      {isUploading && <p className="mle-status" role="status">Uploading image…</p>}

      {isLinkOpen && (
        <div className="mle-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsLinkOpen(false); }}>
          <form className="mle-link-dialog" role="dialog" aria-modal="true" aria-labelledby="mle-link-title" onSubmit={(event) => { event.preventDefault(); applyLink(); }}>
            <div className="mle-dialog-heading"><h2 id="mle-link-title">Insert or edit link</h2><button type="button" className="mle-quiet-button" aria-label="Close link dialog" onClick={() => setIsLinkOpen(false)}><X /></button></div>
            <label>Web address<input autoFocus value={linkValue} onChange={(event) => setLinkValue(event.target.value)} placeholder="https://example.com" /></label>
            {linkError && <p className="mle-error" role="alert">{linkError}</p>}
            <div className="mle-dialog-actions">
              {editor?.isActive("link") && <button type="button" className="mle-quiet-button" onClick={removeLink}>Remove link</button>}
              <button type="button" className="mle-quiet-button" onClick={() => setIsLinkOpen(false)}>Cancel</button>
              <button type="submit" className="mle-action-button">Apply</button>
            </div>
          </form>
        </div>
      )}

      {isBookmarkOpen && (
        <div className="mle-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setIsBookmarkOpen(false); }}>
          <form className="mle-link-dialog" role="dialog" aria-modal="true" aria-labelledby="mle-bookmark-title" onSubmit={insertBookmark}>
            <div className="mle-dialog-heading"><h2 id="mle-bookmark-title">Insert bookmark card</h2><button type="button" className="mle-quiet-button" aria-label="Close bookmark dialog" onClick={() => setIsBookmarkOpen(false)}><X /></button></div>
            <label>Web address<input autoFocus value={bookmarkUrl} onChange={(event) => setBookmarkUrl(event.target.value)} placeholder="https://example.com/article" /></label>
            {bookmarkError && <p className="mle-error" role="alert">{bookmarkError}</p>}
            <div className="mle-dialog-actions">
              <button type="button" className="mle-quiet-button" onClick={() => setIsBookmarkOpen(false)}>Cancel</button>
              <button type="submit" className="mle-action-button">Add card</button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
