import { TextArea, type TextAreaProps } from "@astryxdesign/core/TextArea";
import { TextInput, type TextInputProps } from "@astryxdesign/core/TextInput";
import type { ComponentProps } from "react";

type TextFieldProps = TextInputProps &
  Pick<ComponentProps<"input">, "required" | "minLength" | "maxLength">;

export function TextField({
  required,
  isRequired,
  minLength,
  maxLength,
  width = "min(100%, 40rem)",
  ...props
}: TextFieldProps) {
  const effectiveRequired = required ?? isRequired;
  const constraints = { required: effectiveRequired, minLength, maxLength };
  return (
    <TextInput
      {...props}
      {...constraints}
      {...(effectiveRequired === undefined ? {} : { isRequired: effectiveRequired })}
      width={width}
    />
  );
}

export function TextAreaField({
  required,
  isRequired,
  width = "min(100%, 40rem)",
  ...props
}: TextAreaProps & Pick<ComponentProps<"textarea">, "required">) {
  const effectiveRequired = required ?? isRequired;
  const constraints = { required: effectiveRequired };
  return (
    <TextArea
      {...props}
      {...constraints}
      {...(effectiveRequired === undefined ? {} : { isRequired: effectiveRequired })}
      width={width}
    />
  );
}
