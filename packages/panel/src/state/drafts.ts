import { createSignal } from "solid-js";

/**
 * Unsaved Base URL / Model edits per provider. A field is present only while it differs from the
 * saved value, so a save sends just the fields the user changed (never an untouched, possibly masked
 * Base URL) and edits survive closing the dialog.
 */
export interface ProviderDraft {
  baseURL?: string;
  model?: string;
}

const [all, setAll] = createSignal<Record<string, ProviderDraft>>({});

export function getDraft(id: string): ProviderDraft | undefined {
  return all()[id];
}

/** Sets one field of a provider's draft, or removes it when `value` is undefined. */
export function setDraft(id: string, field: keyof ProviderDraft, value: string | undefined): void {
  setAll((current) => {
    const next: ProviderDraft = { ...current[id] };
    if (value === undefined) delete next[field];
    else next[field] = value;
    const { [id]: _old, ...rest } = current;
    return Object.keys(next).length > 0 ? { ...rest, [id]: next } : rest;
  });
}

export function clearDraft(id: string): void {
  setAll(({ [id]: _old, ...rest }) => rest);
}
