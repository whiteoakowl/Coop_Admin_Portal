// SOURCE for the shared rich-text editor (TipTap/ProseMirror-backed).
// This file is NOT served to the browser - `npm run build:editor`
// (esbuild) bundles it into public/js/forum-editor.js, which every
// calling view already loads via <script src="/js/forum-editor.js">.
// Edit THIS file, never the generated one, then rebuild and commit the
// output (same "vendor a pre-built library" convention public/js/vendor/
// already uses for jsbarcode/qrcode/zxing - this bundle is just self-
// produced instead of downloaded pre-built, since TipTap ships ESM/CJS
// source only, no ready UMD build).
//
// A real request: "upgrade [the shared editor] to resemble more like
// editing a real document in Microsoft Word or Google Docs... full
// editing features for a document" (no comments, no live co-editing).
// Replaces the old document.execCommand-based editor with a real
// ProseMirror document model, while keeping the exact same contract
// every calling view already relies on:
//   - a [data-forum-editor] wrapper (a <form> itself, or a <div> inside one)
//   - a [data-forum-editable] element to mount the editor on, optionally
//     pre-filled with existing saved HTML as its innerHTML
//   - a [data-forum-body-input] hidden <input> the surrounding <form>
//     actually submits, kept in sync with the editor's HTML on every
//     change and on submit
// Everything the editor can produce is still re-validated server-side by
// utils/sanitizeHtml.js regardless of what this file does - that file's
// own comment already says it's the single authoritative contract.
import { Editor, Extension, Node, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle, Color, BackgroundColor, FontFamily, FontSize } from '@tiptap/extension-text-style';
import Image from '@tiptap/extension-image';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import CharacterCount from '@tiptap/extension-character-count';
import Placeholder from '@tiptap/extension-placeholder';

// ---------------------------------------------------------------------
// Custom extensions - the two features TipTap has no official extension
// for (everything else below maps to an official one 1:1).
// ---------------------------------------------------------------------

// Text direction (RTL/LTR) - utils/sanitizeHtml.js already allows a
// plain `dir` attribute on p/div/span/h1-h4/li/blockquote, so this just
// needs to apply/toggle that attribute on whichever of those node types
// the caret is currently in, the same "nearest block ancestor" idea the
// old editor's own closestBlock() walked the DOM for, done here against
// the ProseMirror doc instead.
const TextDirection = Extension.create({
  name: 'textDirection',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading', 'blockquote', 'listItem', 'taskItem'],
        attributes: {
          dir: {
            default: null,
            parseHTML: (el) => el.getAttribute('dir'),
            renderHTML: (attrs) => (attrs.dir ? { dir: attrs.dir } : {}),
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      toggleTextDirection:
        () =>
        ({ state, chain }) => {
          const { $from } = state.selection;
          for (let depth = $from.depth; depth > 0; depth -= 1) {
            const node = $from.node(depth);
            if (node.type.spec.attrs && 'dir' in (node.type.spec.attrs || {})) {
              const next = node.attrs.dir === 'rtl' ? 'ltr' : 'rtl';
              return chain().updateAttributes(node.type.name, { dir: next }).run();
            }
          }
          return false;
        },
    };
  },
});

// YouTube/Vimeo embed - matches the server's own allowedIframeHostnames
// (utils/sanitizeHtml.js); anything else there would just get its src
// stripped and the whole iframe dropped on save. parseVideoEmbedUrl is
// the exact same URL-normalizing logic the old editor used.
function parseVideoEmbedUrl(raw) {
  const youtube = raw.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([\w-]{6,})/);
  if (youtube) return 'https://www.youtube-nocookie.com/embed/' + youtube[1];
  const vimeo = raw.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vimeo) return 'https://player.vimeo.com/video/' + vimeo[1];
  return null;
}

const Embed = Node.create({
  name: 'embed',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: null },
      width: { default: '560' },
      height: { default: '315' },
      allow: {
        default: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture',
      },
      allowfullscreen: { default: 'true' },
    };
  },
  parseHTML() {
    return [{ tag: 'iframe' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['iframe', mergeAttributes(HTMLAttributes)];
  },
  addCommands() {
    return {
      setEmbed:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },
});

// ---------------------------------------------------------------------
// One TipTap instance per [data-forum-editor] wrapper on the page - same
// discovery/guard shape the old editor used.
// ---------------------------------------------------------------------
function initEditor(wrapper) {
  const editable = wrapper.querySelector('[data-forum-editable]');
  const hidden = wrapper.querySelector('[data-forum-body-input]');
  if (!editable || !hidden) return;

  const initialHtml = editable.innerHTML.trim();
  // TipTap mounts its own contenteditable .ProseMirror div INSIDE the
  // element it's given - `editable` stays the outer box (keeps its
  // .forum-editable class/styling/data attribute), so clear its
  // server-rendered starter HTML first or it'd be duplicated alongside
  // the parsed doc TipTap builds from `content` below.
  editable.innerHTML = '';
  editable.removeAttribute('contenteditable');

  function sync() {
    hidden.value = editor.getHTML();
  }

  const editor = new Editor({
    element: editable,
    content: initialHtml,
    extensions: [
      StarterKit.configure({
        link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: null, target: null } },
        // horizontalRule/codeBlock/heading kept at StarterKit's defaults.
      }),
      Subscript,
      Superscript,
      TextAlign.configure({ types: ['paragraph', 'heading'] }),
      TextStyle,
      Color,
      BackgroundColor,
      FontFamily,
      FontSize,
      Image,
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      TaskList,
      TaskItem.configure({ nested: true }),
      TextDirection,
      Embed,
      CharacterCount,
      Placeholder.configure({ placeholder: 'Start writing…' }),
    ],
    onUpdate: () => {
      sync();
      refreshToolbarState();
    },
    onSelectionUpdate: refreshToolbarState,
  });

  const form = wrapper.closest('form');
  if (form) form.addEventListener('submit', sync);
  sync();

  // -------------------------------------------------------------------
  // Toolbar state - buttons light up (.forum-editor-toggle-on) to show
  // what's active at the caret, and the three format/font/size <select>s
  // reflect the current selection instead of always resetting to their
  // placeholder - a real improvement execCommand never made possible
  // (there was no reliable way to ask it "is this currently bold?").
  // -------------------------------------------------------------------
  const TOGGLE_ACTIVE_CHECK = {
    bold: () => editor.isActive('bold'),
    italic: () => editor.isActive('italic'),
    underline: () => editor.isActive('underline'),
    strikeThrough: () => editor.isActive('strike'),
    subscript: () => editor.isActive('subscript'),
    superscript: () => editor.isActive('superscript'),
    justifyLeft: () => editor.isActive({ textAlign: 'left' }),
    justifyCenter: () => editor.isActive({ textAlign: 'center' }),
    justifyRight: () => editor.isActive({ textAlign: 'right' }),
    justifyFull: () => editor.isActive({ textAlign: 'justify' }),
    insertUnorderedList: () => editor.isActive('bulletList'),
    insertOrderedList: () => editor.isActive('orderedList'),
    insertChecklist: () => editor.isActive('taskList'),
  };

  function refreshToolbarState() {
    wrapper.querySelectorAll('[data-forum-cmd]').forEach((control) => {
      const cmd = control.getAttribute('data-forum-cmd');
      if (control.tagName === 'BUTTON' && TOGGLE_ACTIVE_CHECK[cmd]) {
        control.classList.toggle('forum-editor-toggle-on', TOGGLE_ACTIVE_CHECK[cmd]());
      }
    });
    const formatSelect = wrapper.querySelector('select[data-forum-cmd="formatBlock"]');
    if (formatSelect) {
      let value = 'p';
      for (let level = 1; level <= 4; level += 1) {
        if (editor.isActive('heading', { level })) value = 'h' + level;
      }
      if (editor.isActive('codeBlock')) value = 'pre';
      else if (editor.isActive('blockquote')) value = 'blockquote';
      formatSelect.value = value;
    }
    const fontSelect = wrapper.querySelector('select[data-forum-cmd="fontName"]');
    if (fontSelect) fontSelect.value = editor.getAttributes('textStyle').fontFamily || '';
    const sizeSelect = wrapper.querySelector('select[data-forum-cmd="fontSize"]');
    if (sizeSelect) sizeSelect.value = editor.getAttributes('textStyle').fontSize || '';
  }

  // -------------------------------------------------------------------
  // Source-HTML view - same "swap a textarea in over the editor" idea
  // the old editor used, rebuilt against editor.getHTML()/setContent().
  // -------------------------------------------------------------------
  let source = null;
  let sourceOn = false;
  function toggleSource() {
    if (!source) {
      source = document.createElement('textarea');
      source.className = 'forum-editable forum-editor-source-view';
      source.hidden = true;
      editable.insertAdjacentElement('afterend', source);
    }
    sourceOn = !sourceOn;
    if (sourceOn) {
      source.value = editor.getHTML();
      editable.hidden = true;
      source.hidden = false;
    } else {
      editor.commands.setContent(source.value);
      source.hidden = true;
      editable.hidden = false;
      sync();
    }
  }

  // Walks text nodes only via ProseMirror's own doc.descendants - never
  // touches HTML as a string, so it can't corrupt markup whose text
  // happens to contain the search string (same guarantee the old
  // TreeWalker-based version made, just against the doc model instead
  // of live DOM text nodes).
  function findReplaceAll(find, replace) {
    if (!find) return;
    const { state } = editor;
    const tr = state.tr;
    state.doc.descendants((node, pos) => {
      if (!node.isText || !node.text || node.text.indexOf(find) === -1) return;
      const newText = node.text.split(find).join(replace);
      tr.replaceWith(tr.mapping.map(pos), tr.mapping.map(pos + node.nodeSize), state.schema.text(newText, node.marks));
    });
    if (tr.docChanged) editor.view.dispatch(tr);
    sync();
  }

  function insertTable() {
    const rows = parseInt(window.prompt('Number of rows:', '2'), 10);
    const cols = parseInt(window.prompt('Number of columns:', '2'), 10);
    if (!rows || !cols || rows < 1 || cols < 1) return;
    editor
      .chain()
      .focus()
      .insertTable({ rows: Math.min(rows, 20), cols: Math.min(cols, 10), withHeaderRow: false })
      .run();
  }

  function insertVideo() {
    const raw = window.prompt('YouTube or Vimeo video URL:');
    if (!raw) return;
    const embedUrl = parseVideoEmbedUrl(raw);
    if (!embedUrl) {
      window.alert(
        "That doesn't look like a YouTube or Vimeo link. Paste the video's normal page URL (e.g. https://www.youtube.com/watch?v=... or https://vimeo.com/...)."
      );
      return;
    }
    editor.chain().focus().setEmbed({ src: embedUrl }).run();
  }

  // Duplicates the block the caret is in, inserting the copy directly
  // after it - same idea as the old DOM cloneNode version, built as a
  // ProseMirror transaction instead. $from.depth is the caret's deepest
  // block ancestor (the immediate parent - a paragraph, a list item,
  // ...), matching the old editor's own "closest block" semantics.
  function duplicateBlock() {
    const { state } = editor;
    const { $from } = state.selection;
    if ($from.depth === 0) return;
    const node = $from.node($from.depth);
    const after = $from.after($from.depth);
    editor.chain().focus().insertContentAt(after, node.toJSON()).run();
  }

  // Plain-text clipboard read, same reasoning/fallback the old editor
  // documented - modern Chrome blocks execCommand('paste') for scripted
  // callers regardless of a real click, so this uses the async Clipboard
  // API instead; native Ctrl+V already pastes full rich content without
  // going through this button at all.
  function pasteFromClipboard() {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      window.alert("Use Ctrl+V (Cmd+V on Mac) to paste - this browser doesn't allow the Paste button to read the clipboard directly.");
      return;
    }
    navigator.clipboard.readText().then(
      (text) => {
        if (!text) return;
        editor.chain().focus().insertContent(text).run();
      },
      () => {
        window.alert("Use Ctrl+V (Cmd+V on Mac) to paste - the browser didn't allow the Paste button to read the clipboard.");
      }
    );
  }

  function togglePopup(name) {
    wrapper.querySelectorAll('[data-forum-popup]').forEach((p) => {
      const isTarget = p.getAttribute('data-forum-popup') === name;
      p.hidden = isTarget ? !p.hidden : true;
    });
  }

  wrapper.querySelectorAll('.forum-editor-symbol-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      editor.chain().focus().insertContent(btn.getAttribute('data-forum-symbol') || btn.textContent).run();
      togglePopup('symbol');
    });
  });

  const doReplaceBtn = wrapper.querySelector('[data-forum-do-replace]');
  if (doReplaceBtn) {
    doReplaceBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const findInput = wrapper.querySelector('[data-forum-find]');
      const replaceInput = wrapper.querySelector('[data-forum-replace]');
      findReplaceAll(findInput ? findInput.value : '', replaceInput ? replaceInput.value : '');
      togglePopup('findreplace');
    });
  }

  // Maps every data-forum-cmd value the toolbar markup can carry to the
  // chain() call that does it - the toolbar partials themselves are
  // otherwise unchanged, so this table is the one place old command
  // names get translated to TipTap's.
  const COMMANDS = {
    toggleSource,
    toggleSpellcheck: () => {
      editor.view.dom.spellcheck = !editor.view.dom.spellcheck;
    },
    toggleDirection: () => editor.chain().focus().toggleTextDirection().run(),
    toggleFullscreen: () => wrapper.classList.toggle('forum-editor-fullscreen'),
    findReplace: () => togglePopup('findreplace'),
    insertSymbol: () => togglePopup('symbol'),
    insertTable,
    insertChecklist: () => editor.chain().focus().toggleTaskList().run(),
    insertVideo,
    duplicate: duplicateBlock,
    pasteFromClipboard,
    // Only 'paste' is the execCommand browsers now block for scripted
    // callers (see pasteFromClipboard's own comment) - 'copy'/'cut'
    // (writing TO the clipboard from a real click) are still universally
    // supported, so these two keep using them directly rather than
    // reimplementing clipboard writes by hand.
    copy: () => {
      editor.view.dom.focus();
      document.execCommand('copy');
    },
    cut: () => {
      editor.view.dom.focus();
      document.execCommand('cut');
      sync();
    },
    delete: () => editor.chain().focus().deleteSelection().run(),
    createLink: () => {
      const url = window.prompt('Link URL:');
      if (!url) return;
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    },
    unlink: () => editor.chain().focus().unsetLink().run(),
    insertImage: () => {
      const src = window.prompt('Image URL:');
      if (!src) return;
      editor.chain().focus().setImage({ src }).run();
    },
    insertHorizontalRule: () => editor.chain().focus().setHorizontalRule().run(),
    removeFormat: () => editor.chain().focus().unsetAllMarks().clearNodes().run(),
    undo: () => editor.chain().focus().undo().run(),
    redo: () => editor.chain().focus().redo().run(),
    bold: () => editor.chain().focus().toggleBold().run(),
    italic: () => editor.chain().focus().toggleItalic().run(),
    underline: () => editor.chain().focus().toggleUnderline().run(),
    strikeThrough: () => editor.chain().focus().toggleStrike().run(),
    subscript: () => editor.chain().focus().toggleSubscript().run(),
    superscript: () => editor.chain().focus().toggleSuperscript().run(),
    foreColor: (value) => editor.chain().focus().setColor(value).run(),
    hiliteColor: (value) => editor.chain().focus().setBackgroundColor(value).run(),
    justifyLeft: () => editor.chain().focus().setTextAlign('left').run(),
    justifyCenter: () => editor.chain().focus().setTextAlign('center').run(),
    justifyRight: () => editor.chain().focus().setTextAlign('right').run(),
    justifyFull: () => editor.chain().focus().setTextAlign('justify').run(),
    insertUnorderedList: () => editor.chain().focus().toggleBulletList().run(),
    insertOrderedList: () => editor.chain().focus().toggleOrderedList().run(),
    // Lists only (same real-world scope execCommand's own indent/outdent
    // ever reliably covered) - a no-op outside a list.
    outdent: () => editor.chain().focus().liftListItem('listItem').run(),
    indent: () => editor.chain().focus().sinkListItem('listItem').run(),
    formatBlock: (value) => {
      const chain = editor.chain().focus();
      if (/^h[1-4]$/.test(value)) chain.toggleHeading({ level: Number(value[1]) }).run();
      else if (value === 'pre') chain.toggleCodeBlock().run();
      else if (value === 'blockquote') chain.toggleBlockquote().run();
      else chain.setParagraph().run();
    },
    fontName: (value) => (value ? editor.chain().focus().setFontFamily(value).run() : editor.chain().focus().unsetFontFamily().run()),
    fontSize: (value) => (value ? editor.chain().focus().setFontSize(value).run() : editor.chain().focus().unsetFontSize().run()),
  };

  function runCommand(cmd, value) {
    const fn = COMMANDS[cmd];
    if (fn) fn(value);
    refreshToolbarState();
  }

  wrapper.querySelectorAll('[data-forum-cmd]').forEach((control) => {
    const cmd = control.getAttribute('data-forum-cmd');
    if (control.tagName === 'SELECT') {
      control.addEventListener('change', () => {
        runCommand(cmd, control.value);
      });
    } else if (control.tagName === 'INPUT' && control.type === 'color') {
      control.addEventListener('input', () => {
        runCommand(cmd, control.value);
        const glyph = control.closest('label') && control.closest('label').querySelector('[data-color-glyph]');
        if (glyph) glyph.style.borderBottomColor = control.value;
      });
    } else if (control.tagName === 'BUTTON') {
      control.addEventListener('click', (e) => {
        e.preventDefault();
        runCommand(cmd, control.getAttribute('data-forum-value') || null);
      });
    }
  });
}

document.querySelectorAll('[data-forum-editor]').forEach(initEditor);
