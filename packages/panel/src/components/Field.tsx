import type { JSX } from "solid-js";

/** A labelled text input in the dialog's forms. */
export function Field(props: {
  id: string;
  label: string;
  type?: "text" | "password" | "url";
  value: string;
  onInput: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  pattern?: string;
  list?: string;
  autocomplete?: string;
  hidden?: boolean;
  children?: JSX.Element;
}) {
  return (
    <div class="stack" hidden={props.hidden}>
      <label for={props.id}>{props.label}</label>
      <input
        id={props.id}
        type={props.type ?? "text"}
        value={props.value}
        placeholder={props.placeholder}
        required={props.required}
        pattern={props.pattern}
        list={props.list}
        autocomplete={props.autocomplete ?? "off"}
        spellcheck={false}
        onInput={(e) => props.onInput(e.currentTarget.value)}
      />
      {props.children}
    </div>
  );
}
