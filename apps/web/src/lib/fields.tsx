import { TextArea, type TextAreaProps } from "@astryxdesign/core/TextArea";
import { TextInput, type TextInputProps } from "@astryxdesign/core/TextInput";
import type { ComponentProps } from "react";

type TextFieldProps = TextInputProps &
  Pick<ComponentProps<"input">, "required" | "minLength" | "maxLength">;

export function TextField({
  required,
  minLength,
  maxLength,
  width = "min(100%, 40rem)",
  ...props
}: TextFieldProps) {
  // Preserve the native constraints on the input Astryx renders.
  const constraints = { required, minLength, maxLength };
  return <TextInput {...props} {...constraints} width={width} />;
}

export function TextAreaField({
  required,
  width = "min(100%, 40rem)",
  ...props
}: TextAreaProps & Pick<ComponentProps<"textarea">, "required">) {
  const constraints = { required };
  return <TextArea {...props} {...constraints} width={width} />;
}
