// Ambient declarations for the renderer (public/app.js) — libraries loaded with <script> at runtime
// and a few DOM conveniences the code relies on.
interface Window {
  hljs: any; docx: any; XLSX: any; marked: any; Terminal: any; FitAddon: any;
  gr?: { pathForFile(file: File): string };
  gittreeOpen?: (path: string) => unknown;
}
// querySelector / event targets are always HTML elements in this app
interface Element {
  dataset: DOMStringMap; hidden: boolean | string; style: CSSStyleDeclaration; value: any; checked: boolean;
  onclick: any; onmousedown: any; onchange: any; focus(): void; click(): void; select(): void;
  offsetWidth: number; offsetHeight: number; offsetTop: number; placeholder: string;
}
interface EventTarget { closest?(selector: string): any; tagName?: string; dataset?: DOMStringMap; value?: any; checked?: boolean; id?: string; textContent?: string | null }
interface HTMLDivElement { _v?: number; _ver?: number; _sub?: HTMLDivElement | null }

type MenuItem = null | false | undefined | '-' | { head: string } | {
  label: string; run?: () => unknown; hint?: string; tip?: string; icon?: string;
  danger?: boolean; disabled?: boolean; sub?: MenuItem[];
};
type ModalOptions = {
  title: string; text?: string; html?: string; ok?: string | null; danger?: boolean; wide?: boolean;
  input?: string; inputType?: string; inputValue?: string; textarea?: string | null; textareaValue?: string;
  checkbox?: { label: string; checked: boolean } | null;
};
type RunOptions = { label?: string; quiet?: boolean; noUndo?: boolean; force?: boolean };
