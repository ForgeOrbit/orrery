import { Text } from "@astryxdesign/core/Text";
import type { ProjectLabel } from "@orrery/contract";
import type { CSSProperties } from "react";

type LabelStyle = CSSProperties & { "--label-color": string };

// A label's color is project data, not a theme token, so the server owns it. Hand it to
// CSS as a custom property and let the stylesheet own the pill's shape and spacing.
export function LabelPill({ label }: { label: ProjectLabel }) {
  const style: LabelStyle = { "--label-color": label.color };
  return (
    <Text
      as="span"
      type="supporting"
      className="label-pill"
      style={style}
      data-label-id={label.id}
      data-label-name={label.name}
    >
      {label.name}
    </Text>
  );
}
