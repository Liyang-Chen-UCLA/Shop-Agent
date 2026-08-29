import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

const ansi = (code: number) => (text: string) => `\u001b[${code}m${text}\u001b[0m`;
const identity = (text: string) => text;

export const colors = {
  cyan: ansi(36),
  green: ansi(32),
  yellow: ansi(33),
  red: ansi(31),
  gray: ansi(90),
  bold: ansi(1),
  magenta: ansi(35),
};

export const selectTheme: SelectListTheme = {
  selectedPrefix: colors.cyan,
  selectedText: colors.bold,
  description: colors.gray,
  scrollInfo: colors.gray,
  noMatch: colors.yellow,
};

export const editorTheme: EditorTheme = {
  borderColor: colors.cyan,
  selectList: selectTheme,
};

export const markdownTheme: MarkdownTheme = {
  heading: colors.bold,
  link: colors.cyan,
  linkUrl: colors.gray,
  code: colors.yellow,
  codeBlock: identity,
  codeBlockBorder: colors.gray,
  quote: identity,
  quoteBorder: colors.gray,
  hr: colors.gray,
  listBullet: colors.cyan,
  bold: colors.bold,
  italic: ansi(3),
  strikethrough: ansi(9),
  underline: ansi(4),
};
