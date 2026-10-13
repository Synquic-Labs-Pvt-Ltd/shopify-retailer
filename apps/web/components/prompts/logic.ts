import {
  PROMPT_DEFINITIONS,
  PROMPT_MAX_CHARS,
  normalizePromptText,
  usedPlaceholders,
  type PromptDetail,
  type PromptName,
  type PromptVersionInfo,
} from '@rs/shared';
import { relativeTime } from '@/lib/batch/format';

// Pure rules of the Prompts pages (SPEC 12.6): labels, dirty detection, the placeholder panel and the version table.

export const versionLabel = (version: number): string => `v${version}`;

export interface PromptBadge {
  tone: 'neutral' | 'info';
  label: string;
}

// The badge of a prompt in the list: "Global default" or "Custom · v3".
export function promptBadge(activeVersion: number): PromptBadge {
  return activeVersion === 0
    ? { tone: 'neutral', label: 'Global default' }
    : { tone: 'info', label: `Custom · ${versionLabel(activeVersion)}` };
}

// The status line of the editor: "Global default (v0)" or "Custom v3".
export function activeVersionBadge(activeVersion: number): PromptBadge {
  return activeVersion === 0
    ? { tone: 'neutral', label: 'Global default (v0)' }
    : { tone: 'info', label: `Custom ${versionLabel(activeVersion)}` };
}

export function latestVersionText(latestVersion: number): string {
  return latestVersion === 0 ? 'No custom versions yet' : `${versionLabel(latestVersion)} is the latest`;
}

const RELATIVE_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

// "Last edited 5 min ago" for a recent save, "Last edited Mar 3, 2026" for an older one; null for the global default.
export function lastEditedText(updatedAt: string | null, nowMs: number = Date.now()): string | null {
  if (updatedAt === null) return null;
  const at = new Date(updatedAt);
  if (Number.isNaN(at.getTime())) return null;
  if (nowMs - at.getTime() < RELATIVE_DAYS * DAY_MS) return `Last edited ${relativeTime(updatedAt, nowMs)}`;
  return `Last edited ${at.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })}`;
}

// The date and time a version was saved, or a dash for the global default (it was never saved by the store).
export function savedAtText(createdAt: string | null): string {
  if (createdAt === null) return '—';
  const at = new Date(createdAt);
  return Number.isNaN(at.getTime()) ? '—' : at.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

// The note column: what the merchant wrote, a dash when nothing, a name for the global default.
export function noteText(version: Pick<PromptVersionInfo, 'source' | 'note'>): string {
  if (version.source === 'global') return 'Global default';
  return version.note === null || version.note.trim() === '' ? '—' : version.note;
}

export const sizeText = (chars: number): string => chars.toLocaleString('en-US');

export function charCountText(text: string): string {
  return `${sizeText(normalizePromptText(text).length)} of ${sizeText(PROMPT_MAX_CHARS)} characters`;
}

// Newest first, the global default (v0) last, whatever order the server used.
export function orderedVersions(versions: readonly PromptVersionInfo[]): PromptVersionInfo[] {
  return [...versions].sort((a, b) => {
    if (a.version === 0 || b.version === 0) return a.version === 0 ? 1 : -1;
    return b.version - a.version;
  });
}

export const versionActionLabel = (version: number): string => (version === 0 ? 'Use global default' : 'Make active');

// Same comparison the server makes before it stores a text: line endings and trailing space do not count.
export function isDirty(draft: string, loaded: string): boolean {
  return normalizePromptText(draft) !== normalizePromptText(loaded);
}

export function canSavePrompt({ dirty, valid, busy }: { dirty: boolean; valid: boolean; busy: boolean }): boolean {
  return dirty && valid && !busy;
}

// The text of a version that needs no request: the one that is active, and the global default.
export function knownVersionText(detail: Pick<PromptDetail, 'activeVersion' | 'text' | 'globalText'>, version: number): string | null {
  if (version === 0) return detail.globalText;
  return version === detail.activeVersion ? detail.text : null;
}

export const placeholderToken = (name: string): string => `{{${name}}}`;

export interface PlaceholderStatus {
  name: string;
  token: string;
  required: boolean;
  description: string;
  // The text uses it right now.
  present: boolean;
}

// Every placeholder the prompt knows, with whether the draft uses it. Required ones come first, as they are the ones
// a save is refused for.
export function placeholderStatuses(name: PromptName, text: string): PlaceholderStatus[] {
  const used = new Set(usedPlaceholders(text));
  return PROMPT_DEFINITIONS[name].placeholders
    .map((placeholder) => ({
      name: placeholder.name,
      token: placeholderToken(placeholder.name),
      required: placeholder.required,
      description: placeholder.description,
      present: used.has(placeholder.name),
    }))
    .sort((a, b) => Number(b.required) - Number(a.required));
}

// Appends {{name}} to the text, on a new word when the text does not already end in a space or a line break.
export function insertPlaceholder(text: string, name: string): string {
  const token = placeholderToken(name);
  if (text === '' || /\s$/.test(text)) return `${text}${token}`;
  return `${text} ${token}`;
}

// The error banner of the editor: what the live check found, then what the server added that the live check did not.
export function mergeErrors(live: readonly string[], server: readonly string[]): string[] {
  return [...new Set([...live, ...server])];
}
